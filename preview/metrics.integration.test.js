'use strict';
// Real Postgres test for dashboard metrics. Runs only with MOA_INTEGRATION_DB=1 and DATABASE_URL;
// it creates a throwaway schema and drops it afterwards.
//   MOA_INTEGRATION_DB=1 node --env-file=.env.local --test preview/metrics.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPostgresStore } = require('./postgres-store.js');
const { createMetrics, VISIT_GAP_MS } = require('./metrics.js');

test('Postgres metrics: concurrent clicks and visits are counted exactly, across instances', { skip: process.env.MOA_INTEGRATION_DB !== '1' }, async t => {
  const { Pool } = require('pg');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required for integration test');
  const database = new URL(process.env.DATABASE_URL);
  database.hostname = database.hostname.replace('-pooler.', '.');
  database.searchParams.set('sslmode', 'verify-full');
  const admin = new Pool({ connectionString: database.href, max: 1 });
  const schema = 'moa_test_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}`, max: 8 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001-store.sql'), 'utf8'));

  const T0 = Date.parse('2026-11-13T03:00:00Z');
  let clock = T0;
  const store = createPostgresStore({ pool, now: () => clock });
  // two serverless instances sharing one database
  const a = createMetrics({ store, now: () => clock });
  const b = createMetrics({ store, now: () => clock });
  const campaign = { id: 'reviewnote:1', title: '서울 카페', source: 'reviewnote', url: 'https://a/1' };

  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).recordOpen(campaign)));
  await b.recordOpen({ id: 'dinnerqueen:2', title: '<b>부산</b>', source: 'dinnerqueen', url: 'javascript:alert(1)' });

  const user = { id: 'kakao:7', kakaoNickname: '카톡' };
  const counted = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).recordVisit(user)));
  assert.equal(counted.filter(Boolean).length, 1, 'simultaneous loads are one visit');
  clock += VISIT_GAP_MS;
  assert.equal(await a.recordVisit(user), true, 'after the gap a new visit starts');
  assert.equal(await b.recordVisit(user), false);

  const d = await a.dashboard(7, { nicknames: new Map([['kakao:7', '체험러']]), adminIds: new Set() });
  assert.equal(d.collectingSince, new Date(T0).toISOString(), 'first writer sets the start, shared by both instances');
  assert.deepEqual(d.totals, { registeredUsers: 1, activeUsers: 1, newUsers: 1, visits: 2, opens: 21, openedCampaigns: 2 });
  assert.deepEqual(d.campaigns[0], { id: 'reviewnote:1', title: '서울 카페', source: 'reviewnote', url: 'https://a/1', opens: 20, opensAllTime: 20 });
  assert.deepEqual(d.campaigns[1], { id: 'dinnerqueen:2', title: '<b>부산</b>', source: 'dinnerqueen', url: null, opens: 1, opensAllTime: 1 });
  assert.deepEqual(d.users, [{ nickname: '체험러', nicknameSet: true, admin: false, firstVisit: new Date(T0).toISOString(), lastVisit: new Date(clock).toISOString(), visits: 2, visitsInRange: 2 }]);

  const rows = await pool.query("SELECT scope, count(*)::int AS n FROM moa_store GROUP BY scope ORDER BY scope");
  assert.deepEqual(Object.fromEntries(rows.rows.map(r => [r.scope, r.n])), { meta: 1, openday: 2, openmeta: 2, visitday: 1, visitor: 1 });

  clock += 10 * 24 * 3600 * 1000;
  assert.equal((await b.dashboard(7)).totals.opens, 0);
  assert.equal((await b.dashboard(30)).totals.opens, 21);
});
