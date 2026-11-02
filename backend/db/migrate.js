const fs = require('fs/promises');
const path = require('path');

async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const directory = path.join(__dirname, 'migrations');
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE migration_name = $1', [name]);
    if (rowCount) continue;
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (migration_name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied migration ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { runMigrations };
