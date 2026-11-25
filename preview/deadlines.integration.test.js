'use strict';
// Real Postgres test for verified deadlines. Runs only with MOA_INTEGRATION_DB=1 and DATABASE_URL;
// it creates a throwaway schema and drops it afterwards. Original pages are local fixtures (no network).
//   MOA_INTEGRATION_DB=1 node --env-file=.env.local --test preview/deadlines.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPostgresStore } = require('./postgres-store.js');
const { createDeadlineVerifier } = require('./deadlines.js');

const page = (end, sEnd) => `<div>신청 기간</div><div>발표 날짜</div><div>리뷰 기간</div><p>26.11.09 – ${end}</p><p>26.11.20</p><p>26.11.21 – 26.12.01</p>
<script>({ events: [ { title: '신청', start: '2026-11-09', end: '${sEnd}' } ] })</script>`;

test('Postgres deadlines: shared cache, one fetch per campaign across instances, global spacing and daily cap', { skip: process.env.MOA_INTEGRATION_DB !== '1' }, async t => {
  const { Pool } = require('pg');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required for integration test');
  const database = new URL(process.env.DATABASE_URL);
  database.hostname = database.hostname.replace('-pooler.', '.');
  database.searchParams.set('sslmode', 'verify-full');
  const admin = new Pool({ connectionString: database.href, max: 1 });
  const schema = 'moa_test_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}`, max: 6 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001-store.sql'), 'utf8'));

  // one fake clock for both instances; waiting for a slot advances it (no real sleeping)
  const k = { t: Date.parse('2026-11-13T03:00:00Z'), mono: 0 };
  const now = () => k.t;
  const monotonic = () => k.mono;
  const sleep = async ms => { k.t += ms; k.mono += ms; };
  const store = createPostgresStore({ pool, now });
  const calls = [];
  const fetchImpl = async url => {
    calls.push({ path: new URL(url).pathname, at: k.t });
    if (String(url).endsWith('/robots.txt')) return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => 'User-agent: *\nAllow: /' };
    const id = url.split('/').pop();
    return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => (id === '2' ? page('26.11.15', '2026-11-15') : page('26.11.15', '2026-11-16')) };
  };
  const make = () => createDeadlineVerifier({ store, fetch: fetchImpl, now, monotonic, sleep, intervalMs: 1000, dailyCap: 4 });
  const a = make(), b = make(); // two serverless instances sharing the database
  const rec = n => ({ id: `dinnerqueen:${n}`, source: 'dinnerqueen', precision: 'days_left', deadline: '2026-11-20' });

  const first = await Promise.all([a.verifyOne(rec(1)), b.verifyOne(rec(1))]);
  assert.deepEqual(calls.map(c => c.path), ['/robots.txt', '/taste/1'], 'robots once, page once, across instances');
  assert.ok(calls[1].at - calls[0].at >= 1000, 'global 1 s spacing');
  assert.ok(first.some(r => r.status === 'verified'), JSON.stringify(first));
  // the other instance reads the shared result without fetching
  assert.equal((await b.verifyOne(rec(1))).deadline, '2026-11-15');
  assert.equal((await b.verifiedMap()).get('dinnerqueen:1').evidence, '신청 기간 26.11.09 – 26.11.15');
  assert.equal(calls.length, 2);

  assert.equal((await b.verifyOne(rec(2))).status, 'mismatch');
  assert.equal(b.apply(rec(2), await b.verifiedMap()).precision, 'days_left', 'mismatch keeps the estimate');

  // daily cap 4 is shared: robots + 2 pages used, one more allowed today
  assert.equal((await a.verifyOne(rec(3))).status, 'verified');
  assert.deepEqual(await a.verifyOne(rec(4)), { status: 'deferred', reason: 'cap' });
  assert.deepEqual(calls.map(c => c.path), ['/robots.txt', '/taste/1', '/taste/2', '/taste/3']);

  const rows = await pool.query("SELECT key, value FROM moa_store WHERE scope='deadline' ORDER BY key");
  assert.deepEqual(rows.rows.map(r => r.key), ['dinnerqueen:1', 'dinnerqueen:2', 'dinnerqueen:3', 'robots:dinnerqueen.net']);
  assert.ok(rows.rows.every(r => !JSON.stringify(r.value).includes('<')), 'no HTML stored');

  // after 6 hours the cached result expires and is checked again
  k.t += 6 * 3600e3 + 1;
  assert.equal(await store.get('deadline', '', 'dinnerqueen:1'), null);
});
