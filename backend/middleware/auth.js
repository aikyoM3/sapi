function requireAuth(req, res, next) {
  if (req.session?.user?.userId) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
  return res.redirect('/login.html');
}

function currentUserId(req) {
  return Number(req.session.user.userId);
}

module.exports = { requireAuth, currentUserId };
