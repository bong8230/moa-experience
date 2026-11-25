'use strict';
// Run: node --test preview/list-speed.test.js   (no network)
// List speed: a stale list is served at once and refreshed after the response; only listable campaigns are kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('./server.js');

async function serve(t, options) {
  const app = createApp(options);
  const server = http.createServer(app.handler);
  for (let attempt = 1; ; attempt++) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); break; }
    catch (err) { if (err.code !== 'EFAULT' || attempt >= 10) throw err; await new Promise(r => setTimeout(r, 100)); }
  }
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async q => (await fetch(`http://127.0.0.1:${server.address().port}/api/campaigns${q || ''}`)).json();
}

test('stale list is served immediately and refreshed after the response; ?refresh=1 waits for fresh data', async t => {
  let clock = Date.parse('2026-11-13T03:00:00Z');
  let title = '처음 제목';
  let sourceCalls = 0;
  let release = null; // when set, the source answer is held until release() is called
  const fetchImpl = async url => {
    assert.ok(String(url).includes('campaigns.json'));
    sourceCalls++;
    const body = [{ id: 'reviewnote:1', source_id: 'reviewnote', title, original_url: 'https://a/1', last_seen_at: new Date(clock - 3600e3).toISOString(), apply_deadline: '2026-11-30' }];
    if (release) await new Promise(r => { release = r; });
    return { ok: true, status: 200, json: async () => body };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-speed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const later = [];
  const list = await serve(t, { env: { KAKAO_LOCAL: '0' }, fetch: fetchImpl, now: () => clock, favoritesPath: path.join(dir, 'fav.json'), deadlines: false, waitUntil: p => later.push(p) });

  assert.equal((await list()).records[0].title, '처음 제목');
  assert.equal(sourceCalls, 1);
  clock += 31 * 60e3;
  title = '새 제목';
  release = () => {}; // hold the background download
  const stale = await list();
  assert.equal(stale.records[0].title, '처음 제목', 'answered from the stale list without waiting for the source');
  assert.equal(later.length, 1, 'refresh handed to waitUntil');
  assert.equal((await list()).records[0].title, '처음 제목');
  assert.equal(later.length, 1, 'one refresh at a time');
  release(); release = null;
  await Promise.all(later);
  assert.equal((await list()).records[0].title, '새 제목');
  assert.equal(sourceCalls, 2);
  title = '강제 새로고침';
  assert.equal((await list('?refresh=1')).records[0].title, '강제 새로고침', 'refresh=1 still waits');
});

test('without waitUntil on serverless the stale list is refreshed inline (nothing outlives the response)', async t => {
  let clock = Date.parse('2026-11-13T03:00:00Z');
  let title = 'a';
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ id: 'reviewnote:1', source_id: 'reviewnote', title, original_url: 'https://a/1', last_seen_at: new Date(clock - 3600e3).toISOString() }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-speed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = await serve(t, { env: { KAKAO_LOCAL: '0', VERCEL: '1' }, fetch: fetchImpl, now: () => clock, favoritesPath: path.join(dir, 'fav.json'), deadlines: false });
  assert.equal((await list()).records[0].title, 'a');
  clock += 31 * 60e3; title = 'b';
  assert.equal((await list()).records[0].title, 'b');
});

test('a stale cache with no recent campaigns refreshes before replying instead of caching an empty first visit', async t => {
  let clock = Date.parse('2026-11-13T03:00:00Z'), calls = 0;
  const later = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-expired-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = await serve(t, {
    env: { KAKAO_LOCAL: '0' }, now: () => clock, deadlines: false,
    favoritesPath: path.join(dir, 'fav.json'), waitUntil: p => later.push(p),
    fetch: async () => ({ ok: true, json: async () => [{ id: 'reviewnote:1', source_id: 'reviewnote', title: 'source-' + (++calls), last_seen_at: new Date(clock - 3600000).toISOString() }] })
  });
  assert.equal((await list()).records[0].title, 'source-1');
  clock += 49 * 3600000;
  assert.equal((await list()).records[0].title, 'source-2');
  assert.equal(calls, 2);
  assert.equal(later.length, 0, 'an entirely expired snapshot must not be served while refreshing in the background');
});

test('the cache keeps recent campaigns even when their estimated deadline passed (verified overlays decide expiry)', async t => {
  const clock = Date.parse('2026-11-13T03:00:00Z');
  const seen = h => new Date(clock - h * 3600e3).toISOString();
  const source = [
    { id: 'reviewnote:1', source_id: 'reviewnote', title: 'ok', last_seen_at: seen(1), apply_deadline: '2026-11-13' },
    { id: 'reviewnote:2', source_id: 'reviewnote', title: 'old', last_seen_at: seen(49) },
    { id: 'reviewnote:3', source_id: 'reviewnote', title: 'closed', last_seen_at: seen(1), apply_deadline: '2026-11-12' },
    { id: 'reviewnote:4', source_id: 'reviewnote', title: 'no date', last_seen_at: seen(2) }
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-speed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = createApp({ env: { KAKAO_LOCAL: '0' }, fetch: async () => ({ ok: true, status: 200, json: async () => source }), now: () => clock, favoritesPath: path.join(dir, 'fav.json'), deadlines: false });
  const c = await app.campaigns();
  assert.deepEqual(c.records.map(r => r.id), ['reviewnote:1', 'reviewnote:3', 'reviewnote:4']);
});
