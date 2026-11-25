'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('./server.js');
const { createPostgresStore } = require('./postgres-store.js');

test('Postgres: cross-instance OAuth/session, atomic replay prevention, cache and account isolation', { skip: process.env.MOA_INTEGRATION_DB !== '1' }, async t => {
  const { Pool } = require('pg');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required for integration test');
  // Neon PgBouncer disallows startup search_path; tests isolate data on a direct connection.
  const database = new URL(process.env.DATABASE_URL);
  database.hostname = database.hostname.replace('-pooler.', '.');
  database.searchParams.set('sslmode', 'verify-full');
  const connectionString = database.href;
  const admin = new Pool({ connectionString, max: 1 });
  const schema = 'moa_test_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001-store.sql'), 'utf8'));
  const store = createPostgresStore({ pool });
  const stamp = new Date().toISOString();
  const source = [1, 2].map(n => ({ id: `reviewnote:${n}`, source_id: 'reviewnote', title: `실험 ${n}`, original_url: `https://example.com/${n}`, last_seen_at: stamp, category: '기타', campaign_type: '배송형' }));
  let sourceCalls = 0, tokenCalls = 0;
  const fakeFetch = async url => {
    const reply = body => ({ ok: true, json: async () => body });
    if (String(url).includes('campaigns.json')) { sourceCalls++; return reply(source); }
    if (String(url).includes('/oauth/token')) { tokenCalls++; return reply({ access_token: 'fake' }); }
    if (String(url).includes('/v2/user/me')) return reply({ id: 7, properties: { nickname: 'integration' } });
    throw new Error('Unexpected outbound request');
  };
  const env = { KAKAO_REST_API_KEY: 'test', KAKAO_REDIRECT_URI: 'https://example.com/auth/kakao/callback', KAKAO_LOCAL: '0' };
  const apps = [createApp({ store, env, fetch: fakeFetch }), createApp({ store, env, fetch: fakeFetch })];
  let app = apps[0];
  const server = http.createServer((req, res) => app.handler(req, res));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (p, opts) => fetch(base + p, { redirect: 'manual', ...opts });
  const login = await request('/auth/kakao/login');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const oauthCookie = login.headers.get('set-cookie').split(';')[0];
  app = apps[1]; // callback reaches a different instance
  const replies = await Promise.all([0, 1].map(() => request(`/auth/kakao/callback?state=${state}&code=abc`, { headers: { cookie: oauthCookie } })));
  assert.equal(tokenCalls, 1);
  assert.equal(replies.filter(r => r.headers.get('location').includes('login=ok')).length, 1);
  const success = replies.find(r => r.headers.get('location').includes('login=ok'));
  const sid = success.headers.getSetCookie().find(c => c.startsWith('sid=')).split(';')[0];
  app = apps[0];
  assert.equal((await (await request('/api/me', { headers: { cookie: sid } })).json()).user.id, 'kakao:7');
  await Promise.all([1, 2].map(n => request(`/api/favorites/reviewnote%3A${n}`, { method: 'PUT', headers: { cookie: sid } })));
  app = createApp({ store, env, fetch: fakeFetch }); // simulate another cold start
  assert.equal((await (await request('/api/favorites', { headers: { cookie: sid } })).json()).items.length, 2);
  assert.equal(sourceCalls, 1, 'durable cache reused without fetching source on every cold start');
  await store.set('session', '', 'other', { user: { id: 'kakao:8', nickname: 'other' }, expires: Date.now() + 10000 }, Date.now() + 10000);
  assert.equal((await (await request('/api/favorites', { headers: { cookie: 'sid=other' } })).json()).items.length, 0);
  await request('/api/marks/reviewnote%3A1', { method: 'PUT', headers: { cookie: sid, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'excluded' }) });
  assert.equal((await (await request('/api/campaigns', { headers: { cookie: sid } })).json()).total, 1);
  assert.equal((await (await request('/api/campaigns', { headers: { cookie: 'sid=other' } })).json()).total, 2);
  const markPath = '/api/marks/reviewnote%3A2';
  const markHeaders = { cookie: sid, 'Content-Type': 'application/json' };
  assert.equal((await request(markPath, { method: 'PUT', headers: markHeaders, body: JSON.stringify({ status: 'applied' }) })).status, 200);
  const schedule = { stage: 'selected', visitDate: null, reviewDue: '2026-12-01' };
  assert.equal((await request(markPath, { method: 'PATCH', headers: { ...markHeaders, cookie: 'sid=other' }, body: JSON.stringify(schedule) })).status, 404);
  assert.equal((await request(markPath, { method: 'PATCH', headers: markHeaders, body: JSON.stringify(schedule) })).status, 200);
  const applied = await (await request('/api/marks?status=applied', { headers: { cookie: sid } })).json();
  assert.equal(applied.items[0].reviewDue, schedule.reviewDue);
  assert.equal((await request(markPath, { method: 'DELETE', headers: markHeaders })).status, 204);
  assert.equal((await request(markPath, { method: 'PATCH', headers: markHeaders, body: JSON.stringify(schedule) })).status, 404);
  await request('/auth/logout', { method: 'POST', headers: { cookie: sid } });
  assert.equal((await (await request('/api/me', { headers: { cookie: sid } })).json()).user, null);
  const leases = await Promise.all([0, 1].map(n => store.acquire('one', String(n), Date.now() + 10000)));
  assert.equal(leases.filter(Boolean).length, 1);
  const quotas = await Promise.all([0, 1, 2].map(() => store.quota('cap', 2, Date.now() + 10000)));
  assert.equal(quotas.filter(Boolean).length, 2);
});
