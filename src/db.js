const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { db } = require('./config');

const pool = new Pool({
  host: db.host,
  port: db.port,
  database: db.database,
  user: db.user,
  password: db.password,
  max: 10,
  idleTimeoutMillis: 30000,
});

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, initDb };
