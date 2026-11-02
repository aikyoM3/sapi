const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, currentUserId } = require('../middleware/auth');

const router = express.Router();

const cleanUsername = (value) => String(value || '').trim().toLowerCase();

function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.user = { userId: user.user_id, username: user.username, storeName: user.store_name || user.username };
      req.session.save((saveError) => saveError ? reject(saveError) : resolve());
    });
  });
}

module.exports = function authRoutes(pool) {
  router.post('/register', async (req, res, next) => {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || '');
    if (!/^[a-z0-9._-]{3,50}$/.test(username) || password.length < 8) {
      return res.status(400).json({ error: 'Tên đăng nhập cần 3–50 ký tự (chữ, số, dấu chấm, gạch dưới hoặc gạch ngang) và mật khẩu ít nhất 8 ký tự.' });
    }
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
        const firstAccount = !(await client.query('SELECT 1 FROM users LIMIT 1')).rowCount;
        const inserted = await client.query(
          'INSERT INTO users (username, password_hash, store_name) VALUES ($1, $2, NULL) RETURNING user_id',
          [username, passwordHash],
        );
        const userId = inserted.rows[0].user_id;
        if (firstAccount) {
          await client.query('UPDATE supplier SET user_id = $1 WHERE user_id IS NULL', [userId]);
          await client.query('UPDATE product SET user_id = $1 WHERE user_id IS NULL', [userId]);
          await client.query('UPDATE purchaseinvoice SET user_id = $1 WHERE user_id IS NULL', [userId]);
          await client.query('ALTER TABLE supplier VALIDATE CONSTRAINT supplier_user_id_required');
          await client.query('ALTER TABLE product VALIDATE CONSTRAINT product_user_id_required');
          await client.query('ALTER TABLE purchaseinvoice VALIDATE CONSTRAINT purchaseinvoice_user_id_required');
          await client.query('ALTER TABLE purchaseinvoice VALIDATE CONSTRAINT purchaseinvoice_discount_nonnegative');
        }
        await client.query(`INSERT INTO supplier (user_id, supplier_name, phone_number, address)
          SELECT $1, 'Không xác định', NULL, NULL
          WHERE NOT EXISTS (SELECT 1 FROM supplier WHERE user_id=$1 AND LOWER(supplier_name)=LOWER('Không xác định'))`, [userId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      res.status(201).json({ message: 'Đăng ký thành công. Bạn có thể đăng nhập.' });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const username = cleanUsername(req.body.username);
      const { rows } = await pool.query('SELECT user_id, username, store_name, password_hash FROM users WHERE LOWER(username) = $1 LIMIT 1', [username]);
      const user = rows[0];
      const valid = user && await bcrypt.compare(String(req.body.password || ''), user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
      await establishSession(req, user);
      res.json({ user: req.session.user });
    } catch (error) { next(error); }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('sapi.sid');
      res.status(204).end();
    });
  });

  router.get('/me', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
    res.json({ user: req.session.user });
  });

  router.get('/profile', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT store_name, tax_code, address, phone, email FROM users WHERE user_id = $1',
        [currentUserId(req)],
      );
      res.json(rows[0]);
    } catch (error) { next(error); }
  });

  router.put('/profile', requireAuth, async (req, res, next) => {
    const optional = (value, max) => {
      const cleaned = String(value || '').trim();
      return cleaned ? cleaned.slice(0, max) : null;
    };
    const profile = {
      storeName: optional(req.body.storeName, 255),
      taxCode: optional(req.body.taxCode, 100),
      address: optional(req.body.address, 2000),
      phone: optional(req.body.phone, 100),
      email: optional(req.body.email, 320),
    };
    if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      return res.status(400).json({ error: 'Email cửa hàng không hợp lệ.' });
    }
    try {
      const { rows } = await pool.query(`UPDATE users SET store_name=$1, tax_code=$2, address=$3, phone=$4, email=$5, updated_at=NOW()
        WHERE user_id=$6 RETURNING store_name, tax_code, address, phone, email`,
      [profile.storeName, profile.taxCode, profile.address, profile.phone, profile.email, currentUserId(req)]);
      req.session.user.storeName = rows[0].store_name || req.session.user.username;
      await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      res.json(rows[0]);
    } catch (error) { next(error); }
  });

  return router;
};
