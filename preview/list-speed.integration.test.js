'use strict';
// Real Postgres test for the shared list cache. Runs only with MOA_INTEGRATION_DB=1 and DATABASE_URL;
// it creates a throwaway schema and drops it afterwards. The source is a local fixture (no network).
//   MOA_INTEGRATION_DB=1 node --env-file=.env.local --test preview/list-speed.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createApp } = require('./server.js');
const { createPostgresStore } = require('./postgres-store.js');

test('Postgres list cache: compact gzip row, cold start without the source, stale served then refreshed, old row format read', { skip: process.env.MOA_INTEGRATION_DB !== '1' }, async t => {
  const { Pool } = require('pg');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required for integration test');
  const database = new URL(process.env.DATABASE_URL);
  database.hostname = database.hostname.replace('-pooler.', '.');
  database.searchParams.set('sslmode', 'verify-full');
  const admin = new Pool({ connectionString: database.href, max: 1 });
  const schema = 'moa_test_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001-store.sql'), 'utf8'));

  let clock = Date.parse('2026-11-13T03:00:00Z');
  const now = () => clock;
  const store = createPostgresStore({ pool, now });
  let title = '처음', sourceCalls = 0;
  const seen = h => new Date(clock - h * 3600e3).toISOString();
  const fetchImpl = async url => {
    assert.ok(String(url).includes('campaigns.json'), 'only the source is fetched');
    sourceCalls++;
    return { ok: true, status: 200, json: async () => [
      { id: 'reviewnote:1', source_id: 'reviewnote', title, original_url: 'https://a/1', last_seen_at: seen(1), apply_deadline: '2026-11-30' },
      { id: 'reviewnote:2', source_id: 'reviewnote', title: '오래됨', original_url: 'https://a/2', last_seen_at: seen(72) },
      { id: 'reviewnote:3', source_id: 'reviewnote', title: '마감', original_url: 'https://a/3', last_seen_at: seen(1), apply_deadline: '2026-11-01' }
    ] };
  };
  const later = [];
  const instance = () => createApp({ store, env: { KAKAO_LOCAL: '0' }, fetch: fetchImpl, now, deadlines: false, waitUntil: p => later.push(p) });

  // first instance builds the cache
  const a = instance();
  assert.deepEqual((await a.campaigns()).records.map(r => r.id), ['reviewnote:1', 'reviewnote:3']);
  const row = (await pool.query("SELECT value FROM moa_store WHERE scope='cache' AND key='campaigns'")).rows[0].value;
  assert.deepEqual(Object.keys(row).sort(), ['count', 'fetchedAt', 'gz'], 'one compact row: no plain records');
  assert.equal(row.count, 2);
  const stored = JSON.parse(zlib.gunzipSync(Buffer.from(row.gz, 'base64')).toString('utf8'));
  assert.deepEqual(stored.map(r => r.id), ['reviewnote:1', 'reviewnote:3'], 'recent records retain expired estimates for verified-date overlays');

  // cold start of another instance: served from the row, the source is not downloaded again
  const b = instance();
  assert.equal((await b.campaigns()).records[0].title, '처음');
  assert.equal(sourceCalls, 1);

  // stale: a cold instance answers from the stale row at once; the refresh runs after the response
  clock += 31 * 60e3;
  title = '갱신됨';
  const c = instance();
  assert.equal((await c.campaigns()).records[0].title, '처음', 'stale row served without waiting');
  assert.equal(sourceCalls, 1);
  assert.equal(later.length, 1);
  await Promise.all(later);
  assert.equal(sourceCalls, 2);
  assert.equal((await c.campaigns()).records[0].title, '갱신됨');
  // the warm instance b notices the newer shared row instead of downloading again
  assert.equal((await b.campaigns()).records[0].title, '처음', 'b still answers at once from memory');
  await Promise.all(later);
  assert.equal((await b.campaigns()).records[0].title, '갱신됨');
  assert.equal(sourceCalls, 2, 'no second download for the same refresh');

  // a row written by the previous version ({ records: [...] }) is still readable
  await store.set('cache', '', 'campaigns', { fetchedAt: new Date(clock).toISOString(), records: [{ id: 'reviewnote:9', source: 'reviewnote', title: '옛 형식', channels: [], lat: null, lng: null, lastSeen: seen(1), category: '기타' }] });
  const d = instance();
  assert.equal((await d.campaigns()).records[0].title, '옛 형식');
});
