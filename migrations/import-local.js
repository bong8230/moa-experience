'use strict';
// Optional one-time migration. Existing database rows win; local JSON files are never changed.
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let imported = 0;
  try {
    for (const [scope, file] of [['favorite', 'favorites.json'], ['mark', 'marks.json']]) {
      const source = path.join(__dirname, '..', 'preview', 'data', file);
      if (!fs.existsSync(source)) continue;
      const users = JSON.parse(fs.readFileSync(source, 'utf8'));
      for (const [owner, items] of Object.entries(users)) {
        for (const [key, value] of Object.entries(items)) {
          const r = await pool.query('INSERT INTO moa_store(scope,owner,key,value) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key', [scope, owner, key, JSON.stringify(value)]);
          imported += r.rowCount;
        }
      }
    }
    const source = path.join(__dirname, '..', 'preview', 'data', 'kakao-places.json');
    if (fs.existsSync(source)) {
      const entries = JSON.parse(fs.readFileSync(source, 'utf8')).entries || {};
      const fresh = Object.fromEntries(Object.entries(entries).filter(([, value]) => Number(value.t) + 7 * 86400000 > Date.now()));
      const r = await pool.query("INSERT INTO moa_store(scope,owner,key,value,expires) SELECT 'place','',key,value,(value->>'t')::bigint+604800000 FROM jsonb_each($1::jsonb) ON CONFLICT DO NOTHING RETURNING key", [JSON.stringify(fresh)]);
      imported += r.rowCount;
    }
    console.log(`Local migration complete: ${imported} new rows (local files unchanged)`);
  } finally { await pool.end(); }
})().catch(() => { console.error('Local migration failed (check database/schema and local JSON files)'); process.exitCode = 1; });
