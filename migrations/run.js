'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, '001-store.sql'), 'utf8'));
    console.log('Database schema ready');
  } finally { await pool.end(); }
})().catch(() => { console.error('Database migration failed (check DATABASE_URL and database access)'); process.exitCode = 1; });
