'use strict';
// Real Postgres test for saved filters. Runs only with MOA_INTEGRATION_DB=1 and DATABASE_URL;
// it creates a throwaway schema and drops it afterwards.
//   MOA_INTEGRATION_DB=1 node --env-file=.env.local --test preview/preferences.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('./server.js');
const { createPostgresStore } = require('./postgres-store.js');

test('Postgres: filters persist per account across re-login and instances; reset persists; other data untouched', { skip: process.env.MOA_INTEGRATION_DB !== '1' }, async t => {
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
  const store = createPostgresStore({ pool });

  let account = { id: 7, kakao_account: { profile: { nickname: '카톡' } } };
  const fakeFetch = async url => {
    const reply = body => ({ ok: true, json: async () => body });
    if (String(url).includes('campaigns.json')) return reply([]);
    if (String(url).includes('/oauth/token')) return reply({ access_token: 'fake' });
    if (String(url).includes('/v2/user/me')) return reply(account);
    throw new Error('Unexpected outbound request');
  };
  const env = { KAKAO_REST_API_KEY: 'test', KAKAO_REDIRECT_URI: 'https://example.com/auth/kakao/callback', KAKAO_LOCAL: '0', ADMIN_KAKAO_IDS: '7' };
  const instance = () => createApp({ store, env, fetch: fakeFetch });
  let app = instance();
  const server = http.createServer((req, res) => app.handler(req, res));
  // listen() on this Windows host fails intermittently with EFAULT; retry briefly
  for (let attempt = 1; ; attempt++) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); break; }
    catch (err) { if (err.code !== 'EFAULT' || attempt >= 10) throw err; await new Promise(r => setTimeout(r, 100)); }
  }
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (p, opts) => fetch(base + p, { redirect: 'manual', ...opts });
  async function login() {
    const r = await request('/auth/kakao/login');
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    const cb = await request(`/auth/kakao/callback?state=${state}&code=abc`, { headers: { cookie: r.headers.get('set-cookie').split(';')[0] } });
    return cb.headers.getSetCookie().find(c => c.startsWith('sid=')).split(';')[0];
  }
  const get = async sid => (await (await request('/api/preferences', { headers: { cookie: sid } })).json()).preferences;
  const put = (sid, preferences, headers = {}) => request('/api/preferences', { method: 'PUT', headers: { cookie: sid, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ preferences }) });
  const A = { categories: ['카페', '맛집'], sources: ['reviewnote'], channels: ['블로그', '인스타그램'], regions: [], q: '성수', near: { label: '현재 위치', lat: 37.5446123, lng: 127.0559876 }, radius: 20, includeNoLoc: true, sort: 'distance' };
  const savedA = { ...A, near: { label: '현재 위치', lat: 37.545, lng: 127.056 } };

  const a1 = await login();
  assert.equal(await get(a1), null);
  assert.equal((await put(a1, { nickname: 'x' })).status, 200, 'unknown fields ignored');
  assert.equal((await put(a1, { ...A, userId: 'kakao:8' }, { 'X-Moa-Account': 'kakao:7' })).status, 200);
  assert.equal((await request('/api/profile', { method: 'PUT', headers: { cookie: a1, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: '체험러' }) })).status, 200);

  // logout, re-login on another serverless instance
  await request('/auth/logout', { method: 'POST', headers: { cookie: a1 } });
  app = instance();
  const a2 = await login();
  assert.deepEqual(await get(a2), savedA);
  const me = (await (await request('/api/me', { headers: { cookie: a2 } })).json()).user;
  assert.equal(me.nickname, '체험러');
  assert.equal(me.isAdmin, true);

  const rows = await pool.query("SELECT scope, key, value FROM moa_store WHERE owner='kakao:7' AND scope IN ('preferences','profile') ORDER BY scope");
  assert.deepEqual(rows.rows.map(r => [r.scope, r.key]), [['preferences', 'filters'], ['profile', 'main']], 'separate rows');
  assert.equal(rows.rows[0].value.near.lat, 37.545, 'stored at 3 decimals');
  assert.ok(!JSON.stringify(rows.rows[0].value).includes('kakao:8'));

  // account B: separate, empty, cannot be written from a tab that still thinks it is A
  account = { id: 8, properties: { nickname: '비' } };
  const b = await login();
  assert.equal(await get(b), null, 'nothing copied from A');
  assert.equal((await put(b, { q: 'stale tab' }, { 'X-Moa-Account': 'kakao:7' })).status, 409);
  assert.equal(await get(b), null);
  const crossRead = await request('/api/preferences', { headers: { cookie: b, 'X-Moa-Account': 'kakao:7' } });
  assert.equal(crossRead.status, 409, 'tab still on A cannot read B');
  assert.equal((await put(b, { regions: ['부산'] })).status, 200);
  assert.deepEqual((await get(b)).regions, ['부산']);
  assert.equal((await (await request('/api/me', { headers: { cookie: b } })).json()).user.isAdmin, false);
  assert.deepEqual(await get(a2), savedA, 'A untouched by B');

  // explicit reset persists
  assert.equal((await put(a2, {})).status, 200);
  app = instance();
  assert.deepEqual(await get(a2), { categories: [], sources: [], channels: [], regions: [], q: '', near: null, radius: 10, includeNoLoc: false, sort: 'deadline' });
  assert.equal((await (await request('/api/me', { headers: { cookie: a2 } })).json()).user.nickname, '체험러', 'nickname kept after reset');
});
