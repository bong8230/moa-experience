'use strict';
// Real Postgres test for app nicknames. Runs only with MOA_INTEGRATION_DB=1 and DATABASE_URL;
// it creates a throwaway schema and drops it afterwards.
//   MOA_INTEGRATION_DB=1 node --env-file=.env.local --test preview/profile.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('./server.js');
const { createPostgresStore } = require('./postgres-store.js');

test('Postgres: nickname persists per Kakao account across instances, sessions and re-login', { skip: process.env.MOA_INTEGRATION_DB !== '1' }, async t => {
  const { Pool } = require('pg');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required for integration test');
  const database = new URL(process.env.DATABASE_URL);
  database.hostname = database.hostname.replace('-pooler.', '.');
  database.searchParams.set('sslmode', 'verify-full');
  const admin = new Pool({ connectionString: database.href, max: 1 });
  const schema = 'moa_test_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}`, max: 3 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001-store.sql'), 'utf8'));
  const store = createPostgresStore({ pool });

  let account = { id: 7, kakao_account: {} }; // no Kakao nickname
  const fakeFetch = async url => {
    const reply = body => ({ ok: true, json: async () => body });
    if (String(url).includes('campaigns.json')) return reply([]);
    if (String(url).includes('/oauth/token')) return reply({ access_token: 'fake' });
    if (String(url).includes('/v2/user/me')) return reply(account);
    throw new Error('Unexpected outbound request');
  };
  const env = { KAKAO_REST_API_KEY: 'test', KAKAO_REDIRECT_URI: 'https://example.com/auth/kakao/callback', KAKAO_LOCAL: '0' };
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
  const me = async sid => (await (await request('/api/me', { headers: { cookie: sid } })).json()).user;
  const put = (sid, nickname) => request('/api/profile', { method: 'PUT', headers: { cookie: sid, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname }) });

  const phone = await login();
  const pc = await login();
  assert.deepEqual(await me(phone), { id: 'kakao:7', nickname: '카카오 사용자', nicknameSet: false, kakaoNickname: null, isAdmin: false });
  assert.equal((await put(phone, '가')).status, 400);

  assert.equal((await put(phone, ' 체험 헌터 ')).status, 200);
  app = instance(); // another serverless instance / cold start
  assert.equal((await me(pc)).nickname, '체험 헌터', 'other session, other instance');
  const row = await pool.query("SELECT value FROM moa_store WHERE scope='profile' AND owner='kakao:7' AND key='main'");
  assert.equal(row.rows[0].value.nickname, '체험 헌터');
  assert.equal(row.rows.length, 1);

  assert.equal((await put(pc, '체험 헌터2')).status, 200, 'edit from another device');
  assert.equal((await me(phone)).nickname, '체험 헌터2');
  assert.equal((await pool.query("SELECT 1 FROM moa_store WHERE scope='profile' AND owner='kakao:7'")).rows.length, 1, 'update in place');

  await request('/auth/logout', { method: 'POST', headers: { cookie: phone } });
  assert.equal(await me(phone), null);
  const again = await login();
  assert.deepEqual(await me(again), { id: 'kakao:7', nickname: '체험 헌터2', nicknameSet: true, kakaoNickname: null, isAdmin: false });

  account = { id: 8, properties: { nickname: '카톡' } };
  const other = await login();
  assert.equal((await me(other)).nickname, '카톡');
  assert.equal((await put(other, '체험 헌터2')).status, 200, 'same nickname allowed for another account');
  assert.equal((await me(other)).id, 'kakao:8');
  assert.equal((await me(again)).id, 'kakao:7');
});
