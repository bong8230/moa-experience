'use strict';
// Run: node --test preview/server.test.js   (no network, no real Kakao calls)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, safeReturn, parseAdminIds } = require('./server.js');

const NOW = Date.parse('2026-11-13T03:00:00Z');
const recent = new Date(NOW - 3600 * 1000).toISOString();
const old = new Date(NOW - 72 * 3600 * 1000).toISOString();
const SOURCE = [
  { id: 'reviewnote:1', source_id: 'reviewnote', title: '서울 카페', original_url: 'https://a/1', category: '카페', channels: ['블로그', '인스타그램'], apply_deadline: '2026-11-20', last_seen_at: recent, campaign_type: '방문형', region_sido: '서울', region_text: '서울 성수' },
  { id: 'dinnerqueen:2', source_id: 'dinnerqueen', title: '부산 맛집', original_url: 'https://a/2', category: '맛집', channels: ['블로그'], apply_deadline: '2026-11-15', last_seen_at: recent, campaign_type: '방문형', region_sido: '부산', region_text: '부산/해운대구' },
  { id: 'bqueens:3', source_id: 'bqueens', title: '배송 세럼', original_url: 'https://a/3', category: null, apply_deadline: null, last_seen_at: recent, campaign_type: '배송형', region_sido: null, region_text: null },
  { id: 'reviewnote:4', source_id: 'reviewnote', title: '오래된 공고', original_url: 'https://a/4', category: '카페', apply_deadline: '2026-11-30', last_seen_at: old, campaign_type: '방문형', region_sido: '서울', region_text: '서울' },
  { id: 'reviewnote:5', source_id: 'reviewnote', title: '마감 지남', original_url: 'https://a/5', category: '카페', apply_deadline: '2026-11-01', last_seen_at: recent, campaign_type: '방문형', region_sido: '서울', region_text: '서울' }
];
const KAKAO_ENV = { KAKAO_REST_API_KEY: 'test-key', KAKAO_CLIENT_SECRET: 'test-secret', KAKAO_REDIRECT_URI: 'http://localhost/auth/kakao/callback' };

function fakeFetch(calls, opts = {}) {
  const { tokenStatus = 200 } = opts;
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).includes('campaigns.json')) return reply(opts.sourceStatus || 200, opts.source || SOURCE);
    if (String(url) === 'https://kauth.kakao.com/oauth/token') return reply(tokenStatus, { access_token: 'tok-abc' });
    // opts.me is read per call so a test can switch the Kakao account between logins
    if (String(url) === 'https://kapi.kakao.com/v2/user/me') return reply(200, opts.me || { id: 42, kakao_account: { profile: { nickname: '테스터' } } });
    throw new Error('unexpected fetch ' + url);
  };
}

// One shared listener for all tests (repeated ephemeral binds were flaky on this Windows host: EFAULT).
let current = null;
const shared = http.createServer((req, res) => current(req, res));
test.before(async () => {
  // listen() on this host fails intermittently with EFAULT; retry a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onListening = () => { shared.off('error', onError); resolve(); };
        const onError = err => { shared.off('listening', onListening); reject(err); };
        shared.once('error', onError);
        shared.listen(0, '127.0.0.1', onListening);
      });
      return;
    } catch (err) {
      if (err.code !== 'EFAULT' || attempt >= 10) throw err;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
});
test.after(() => new Promise(resolve => { shared.closeAllConnections(); shared.close(resolve); }));

async function start(t, { env = {}, fetchOpts, places, dir: keepDir, now = () => NOW, deadlines = false } = {}) {
  const dir = keepDir || fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(dir, 'admin.html'), '<!doctype html><title>admin-shell</title>');
  const calls = [];
  const app = createApp({ env, fetch: fakeFetch(calls, fetchOpts), now, favoritesPath: path.join(dir, 'data', 'fav.json'), indexPath: path.join(dir, 'index.html'), adminPath: path.join(dir, 'admin.html'), places, deadlines }); // original-page deadline checks off unless a test passes a verifier
  current = app.handler;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${shared.address().port}`;
  const req = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  return { base, req, calls, dir, app };
}

async function loginFlow(ctx, returnTo = '/') {
  const r1 = await ctx.req('/auth/kakao/login?return=' + encodeURIComponent(returnTo));
  assert.equal(r1.status, 302);
  const loc = new URL(r1.headers.get('location'));
  const state = loc.searchParams.get('state');
  const stateCookie = r1.headers.getSetCookie().find(c => c.startsWith('oauth_state=')).split(';')[0];
  const r2 = await ctx.req(`/auth/kakao/callback?code=c1&state=${state}`, { headers: { cookie: stateCookie } });
  const sid = r2.headers.getSetCookie().find(c => c.startsWith('sid='));
  return { r1, r2, loc, state, stateCookie, sidCookie: sid && sid.split(';')[0] };
}

test('daily digest uses saved filters, KST first-seen date and application state; tracked schedules survive re-login', async t => {
  const fetchOpts = { source: SOURCE.map((record, i) => ({ ...record, first_seen_at: i === 1 ? '2026-11-12T14:59:59Z' : recent })) };
  const ctx = await start(t, { env: KAKAO_ENV, fetchOpts });
  assert.equal((await ctx.req('/api/digest')).status, 401);
  const { sidCookie } = await loginFlow(ctx);
  const headers = { cookie: sidCookie, 'Content-Type': 'application/json' };
  const request = (path, method = 'GET', body) => ctx.req(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await (await request('/api/digest')).json()).configured, false);
  assert.equal((await request('/api/preferences', 'PUT', { preferences: { channels: ['블로그'] } })).status, 200);
  const digest = await (await request('/api/digest')).json();
  assert.equal(digest.day, '2026-11-13');
  assert.deepEqual(digest.items.map(item => item.id), ['reviewnote:1']);
  assert.deepEqual(await (await request('/api/digest?summary=1')).json(), { day: digest.day, configured: true, total: 1, items: [] });
  const id = 'reviewnote%3A1';
  assert.equal((await request(`/api/marks/${id}`, 'PUT', { status: 'applied' })).status, 200);
  const schedule = { stage: 'selected', visitDate: '2026-11-20', reviewDue: '2026-11-27' };
  assert.equal((await request(`/api/marks/${id}`, 'PATCH', { ...schedule, visitDate: '2026-11-31' })).status, 400);
  assert.equal((await request(`/api/marks/${id}`, 'PATCH', schedule)).status, 200);
  assert.equal((await (await request('/api/digest')).json()).total, 0);
  const again = await loginFlow(ctx);
  const { items } = await (await ctx.req('/api/marks?status=applied', { headers: { cookie: again.sidCookie } })).json();
  assert.deepEqual([items[0].stage, items[0].visitDate, items[0].reviewDue], Object.values(schedule));
  await request(`/api/marks/${id}`, 'DELETE');
  assert.equal((await request(`/api/marks/${id}`, 'PATCH', schedule)).status, 404);
});

test('original venue coordinates control radius and manager can see collection failures and coverage', async t => {
  const entry = { place: { lat: 37.5, lng: 127.1 } };
  const deadlines = { verifiedMap: async () => new Map([['dinnerqueen:2', entry]]), verifySome: async () => ({}),
    apply: record => record.id === 'dinnerqueen:2' ? { ...record, addressOrigin: 'campaign', address: '부산 매장 주소' } : record };
  const fetchOpts = {};
  const ctx = await start(t, { deadlines, fetchOpts, env: { ...KAKAO_ENV, ADMIN_KAKAO_IDS: '42' } });
  const data = await (await ctx.req('/api/campaigns?source=dinnerqueen&lat=37.5&lng=127.1&radius=1')).json();
  assert.equal(data.stale, false);
  assert.equal(data.records[0].geoLevel, 'original');
  assert.equal(data.records[0].distanceKm, 0);
  assert.equal(data.records[0].lat, undefined);
  fetchOpts.sourceStatus = 503;
  assert.equal((await ctx.req('/api/campaigns?refresh=1')).status, 502);
  const { sidCookie } = await loginFlow(ctx);
  const { collection } = await (await ctx.req('/api/admin/dashboard', { headers: { cookie: sidCookie } })).json();
  assert.equal(collection.lastAttempt.reason, 'HTTP 503');
  assert.equal(collection.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual(collection.coverage.find(row => row.source === 'dinnerqueen'), { source: 'dinnerqueen', visits: 1, original: 1, kakao: 0, originalCoordinates: 1 });
});

test('리뷰 매체를 다중 선택하고 다른 필터와 함께 적용한다', async t => {
  const ctx = await start(t);
  const params = new URLSearchParams([['channel', '인스타그램'], ['region', '서울']]);
  const response = await ctx.req('/api/campaigns?' + params);
  const result = await response.json();
  assert.deepEqual(result.records.map(r => r.id), ['reviewnote:1']);
  assert.deepEqual(result.records[0].channels, ['블로그', '인스타그램']);
  assert.ok(result.channels.includes('인스타그램'));
  const multi = await (await ctx.req('/api/campaigns?' + new URLSearchParams([['channel', '인스타그램'], ['channel', '블로그']]))).json();
  assert.deepEqual(multi.records.map(r => r.id), ['dinnerqueen:2', 'reviewnote:1']);
});

test('campaign list works without Kakao config; adds id/region fields', async t => {
  const ctx = await start(t);
  const me = await (await ctx.req('/api/me')).json();
  assert.deepEqual(me, { authEnabled: false, user: null });
  const body = await (await ctx.req('/api/campaigns')).json();
  assert.equal(body.total, 3, 'stale (>48h) and past-deadline records excluded');
  assert.deepEqual(body.regions, ['부산', '서울', '전국']);
  const r = body.records.find(x => x.id === 'reviewnote:1');
  assert.equal(r.region_sido, '서울');
  assert.equal(r.region_text, '서울 성수');
  assert.equal(r.favorite, false);
  assert.equal(body.records.find(x => x.id === 'bqueens:3').category, '기타');
  assert.equal((await ctx.req('/auth/kakao/login')).status, 503);
  assert.equal((await ctx.req('/api/favorites')).status, 401);
  assert.equal((await ctx.req('/')).status, 200);
});

test('region filter: sido OR, 전국 = no region, AND with other groups', async t => {
  const ctx = await start(t);
  const ids = async q => (await (await ctx.req('/api/campaigns?' + q)).json()).records.map(r => r.id).sort();
  assert.deepEqual(await ids('region=서울'), ['reviewnote:1']);
  assert.deepEqual(await ids('region=서울&region=부산'), ['dinnerqueen:2', 'reviewnote:1']);
  assert.deepEqual(await ids('region=전국'), ['bqueens:3']);
  assert.deepEqual(await ids('region=부산&region=전국'), ['bqueens:3', 'dinnerqueen:2']);
  assert.deepEqual(await ids('region=서울&category=맛집'), []);
  assert.deepEqual(await ids('q=해운대'), ['dinnerqueen:2'], 'q also searches region_text');
});

test('login redirect carries state and config; secret not exposed', async t => {
  const ctx = await start(t, { env: KAKAO_ENV });
  const { loc, r1 } = await loginFlow(ctx);
  assert.equal(loc.origin + loc.pathname, 'https://kauth.kakao.com/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'test-key');
  assert.equal(loc.searchParams.get('redirect_uri'), KAKAO_ENV.KAKAO_REDIRECT_URI);
  assert.ok(loc.searchParams.get('state').length >= 32);
  assert.ok(!r1.headers.get('location').includes('test-secret'));
  const c = r1.headers.getSetCookie().find(x => x.startsWith('oauth_state='));
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/);
});

test('callback rejects wrong, missing, or replayed state', async t => {
  const ctx = await start(t, { env: KAKAO_ENV });
  const r1 = await ctx.req('/auth/kakao/login');
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const bad = await ctx.req(`/auth/kakao/callback?code=c&state=${state}`, { headers: { cookie: 'oauth_state=other' } });
  assert.equal(bad.headers.get('location'), '/?login=error&reason=state');
  // state consumed even on failure → replay with right cookie also fails
  const replay = await ctx.req(`/auth/kakao/callback?code=c&state=${state}`, { headers: { cookie: `oauth_state=${state}` } });
  assert.equal(replay.headers.get('location'), '/?login=error&reason=state');
  const none = await ctx.req('/auth/kakao/callback?code=c');
  assert.equal(none.headers.get('location'), '/?login=error&reason=state');
  assert.ok(!ctx.calls.some(c => c.url.includes('oauth/token')), 'no token exchange on bad state');
});

test('successful login creates server session; token exchange sends secret server-side', async t => {
  const ctx = await start(t, { env: KAKAO_ENV });
  const { r2, sidCookie } = await loginFlow(ctx, '/?tab=fav');
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/?tab=fav&login=ok');
  assert.ok(sidCookie);
  const tokenCall = ctx.calls.find(c => c.url.includes('oauth/token'));
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get('client_secret'), 'test-secret');
  assert.equal(form.get('code'), 'c1');
  const me = await (await ctx.req('/api/me', { headers: { cookie: sidCookie } })).json();
  assert.deepEqual(me, { authEnabled: true, user: { id: 'kakao:42', nickname: '테스터', nicknameSet: false, kakaoNickname: '테스터', isAdmin: false } });
  assert.ok(!JSON.stringify(me).includes('tok-abc'), 'Kakao token never returned');
  const out = await ctx.req('/auth/logout', { method: 'POST', headers: { cookie: sidCookie } });
  assert.equal(out.status, 204);
  assert.equal((await (await ctx.req('/api/me', { headers: { cookie: sidCookie } })).json()).user, null);
});

test('Kakao failure and user denial redirect with reason', async t => {
  const ctx = await start(t, { env: KAKAO_ENV, fetchOpts: { tokenStatus: 401 } });
  const { r2, sidCookie } = await loginFlow(ctx);
  assert.equal(r2.headers.get('location'), '/?login=error&reason=kakao');
  assert.equal(sidCookie, undefined);
  const r1 = await ctx.req('/auth/kakao/login');
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const denied = await ctx.req(`/auth/kakao/callback?error=access_denied&state=${state}`, { headers: { cookie: `oauth_state=${state}` } });
  assert.equal(denied.headers.get('location'), '/?login=error&reason=denied');
});

test('return path cannot redirect off-site', () => {
  assert.equal(safeReturn('//evil.com'), '/');
  assert.equal(safeReturn('https://evil.com'), '/');
  assert.equal(safeReturn('/\\evil.com'), '/');
  assert.equal(safeReturn(null), '/');
  assert.equal(safeReturn('/?a=1'), '/?a=1');
});

test('favorites: per-account, idempotent, persisted, flagged in list', async t => {
  const ctx = await start(t, { env: KAKAO_ENV });
  const { sidCookie } = await loginFlow(ctx);
  const h = { cookie: sidCookie };
  const id = encodeURIComponent('reviewnote:1');
  const put1 = await ctx.req(`/api/favorites/${id}`, { method: 'PUT', headers: h });
  assert.equal(put1.status, 200);
  const item = (await put1.json()).item;
  assert.equal(item.region_text, '서울 성수');
  assert.equal((await ctx.req(`/api/favorites/${id}`, { method: 'PUT', headers: h })).status, 200);
  const list = await (await ctx.req('/api/favorites', { headers: h })).json();
  assert.equal(list.items.length, 1);
  const camp = await (await ctx.req('/api/campaigns', { headers: h })).json();
  assert.equal(camp.records.find(r => r.id === 'reviewnote:1').favorite, true);
  assert.equal((await ctx.req(`/api/favorites/${encodeURIComponent('reviewnote:999')}`, { method: 'PUT', headers: h })).status, 404);
  assert.equal((await ctx.req('/api/favorites/bad%20id', { method: 'PUT', headers: h })).status, 400);
  await ctx.app.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'data', 'fav.json'), 'utf8'));
  assert.ok(saved['kakao:42']['reviewnote:1']);
  assert.equal((await ctx.req(`/api/favorites/${id}`, { method: 'DELETE', headers: h })).status, 204);
  assert.equal((await (await ctx.req('/api/favorites', { headers: h })).json()).items.length, 0);
});

test('state-changing requests from another origin are rejected', async t => {
  const ctx = await start(t, { env: KAKAO_ENV });
  const { sidCookie } = await loginFlow(ctx);
  const r = await ctx.req(`/api/favorites/${encodeURIComponent('reviewnote:1')}`, { method: 'PUT', headers: { cookie: sidCookie, origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'bad_origin');
});

test('missing index.html returns 500 instead of crashing', async t => {
  const ctx = await start(t);
  fs.rmSync(path.join(ctx.dir, 'index.html'));
  assert.equal((await ctx.req('/')).status, 500);
  assert.equal((await ctx.req('/api/me')).status, 200, 'server still alive');
});

test('manual favorite: login required, validated, platform detected, listed and deletable', async t => {
  const ctx = await start(t, { env: KAKAO_ENV });
  const post = (body, headers = {}) => ctx.req('/api/favorites/manual', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ title: 'x', url: 'https://www.musinsa.com/preuser/events/48484' })).status, 401);
  const { sidCookie } = await loginFlow(ctx);
  const h = { cookie: sidCookie };
  assert.equal((await post({ title: '', url: 'https://www.musinsa.com/' }, h)).status, 400);
  assert.equal((await post({ title: 'a', url: 'javascript:alert(1)' }, h)).status, 400);
  assert.equal((await post({ title: 'a', url: 'http://www.musinsa.com/' }, h)).status, 400, 'https only');
  assert.equal((await post({ title: 'a', url: 'https://www.musinsa.com/', deadline: '11/20' }, h)).status, 400);
  const bad = await ctx.req('/api/favorites/manual', { method: 'POST', headers: h, body: '{not json' });
  assert.equal(bad.status, 400);
  const ok = await post({ title: '무신사 니트 체험단', url: 'https://www.musinsa.com/preuser/events/48484', deadline: '2026-11-20', note: '사이즈 M' }, h);
  assert.equal(ok.status, 201);
  const item = (await ok.json()).item;
  assert.match(item.id, /^manual:/);
  assert.equal(item.source, 'musinsa');
  assert.equal(item.manual, true);
  const kakao = (await (await post({ title: '선물하기 체험단', url: 'https://gift.kakao.com/product/1' }, h)).json()).item;
  assert.equal(kakao.source, 'kakao-gift');
  const other = (await (await post({ title: '기타', url: 'https://evilmusinsa.com/x' }, h)).json()).item;
  assert.equal(other.source, 'other', 'suffix match must be on a domain boundary');
  const invite = await post({ title: '쿠팡 초대 체험단', platform: 'coupang', deadline: '2026-11-27' }, h);
  assert.equal(invite.status, 201, 'url optional when platform given');
  const inviteItem = (await invite.json()).item;
  assert.equal(inviteItem.source, 'coupang');
  assert.equal(inviteItem.url, null);
  assert.equal((await post({ title: '링크도 플랫폼도 없음' }, h)).status, 400);
  const list = await (await ctx.req('/api/favorites', { headers: h })).json();
  assert.equal(list.items.length, 4);
  assert.equal((await ctx.req('/api/favorites/' + encodeURIComponent(item.id), { method: 'DELETE', headers: h })).status, 204);
  assert.equal((await (await ctx.req('/api/favorites', { headers: h })).json()).items.length, 3);
  const cross = await ctx.req('/api/favorites/manual', { method: 'POST', headers: { ...h, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'a', url: 'https://www.musinsa.com/' }) });
  assert.equal(cross.status, 403);
});

test('marks: applied shows status, excluded hidden per account, survives re-login, restorable', async t => {
  const ctx = await start(t, { env: KAKAO_ENV });
  const put = (id, status, h) => ctx.req('/api/marks/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ status }) });
  assert.equal((await put('reviewnote:1', 'applied', {})).status, 401);
  const { sidCookie } = await loginFlow(ctx);
  const h = { cookie: sidCookie };
  assert.equal((await put('reviewnote:1', 'bogus', h)).status, 400);
  assert.equal((await put('reviewnote:999', 'applied', h)).status, 404);
  assert.equal((await put('reviewnote:1', 'applied', h)).status, 200);
  assert.equal((await put('dinnerqueen:2', 'excluded', h)).status, 200);
  const list = await (await ctx.req('/api/campaigns', { headers: h })).json();
  assert.equal(list.total, 2, 'excluded removed from list and total');
  assert.equal(list.excludedHidden, 1);
  assert.ok(!list.records.some(r => r.id === 'dinnerqueen:2'));
  assert.equal(list.records.find(r => r.id === 'reviewnote:1').status, 'applied');
  // other viewers (anonymous) still see everything
  assert.equal((await (await ctx.req('/api/campaigns')).json()).total, 3);
  // excluded favorite is hidden from favorites too
  await ctx.req('/api/favorites/' + encodeURIComponent('dinnerqueen:2'), { method: 'PUT', headers: h });
  assert.equal((await (await ctx.req('/api/favorites', { headers: h })).json()).items.length, 0);
  // logout + login again (new session, same Kakao id) keeps marks
  await ctx.req('/auth/logout', { method: 'POST', headers: h });
  const again = { cookie: (await loginFlow(ctx)).sidCookie };
  const excluded = await (await ctx.req('/api/marks?status=excluded', { headers: again })).json();
  assert.deepEqual(excluded.items.map(m => m.id), ['dinnerqueen:2']);
  assert.equal(excluded.items[0].title, '부산 맛집', 'snapshot stored');
  assert.equal((await (await ctx.req('/api/campaigns', { headers: again })).json()).total, 2);
  await ctx.app.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'data', 'marks.json'), 'utf8'));
  assert.equal(saved['kakao:42']['dinnerqueen:2'].status, 'excluded');
  // single restore, then bulk restore
  assert.equal((await ctx.req('/api/marks/' + encodeURIComponent('dinnerqueen:2'), { method: 'DELETE', headers: again })).status, 204);
  assert.equal((await (await ctx.req('/api/campaigns', { headers: again })).json()).total, 3);
  await put('dinnerqueen:2', 'excluded', again);
  await put('bqueens:3', 'excluded', again);
  const bulk = await (await ctx.req('/api/marks?status=excluded', { method: 'DELETE', headers: again })).json();
  assert.equal(bulk.removed, 2);
  const after = await (await ctx.req('/api/campaigns', { headers: again })).json();
  assert.equal(after.total, 3);
  assert.equal(after.records.find(r => r.id === 'reviewnote:1').status, 'applied', 'bulk restore leaves applied');
  assert.equal((await ctx.req('/api/marks?status=nope', { method: 'DELETE', headers: again })).status, 400);
});

test('radius search around a point uses approximate area centroids', async t => {
  const ctx = await start(t);
  const q = params => ctx.req('/api/campaigns?' + new URLSearchParams(params)).then(r => r.json());
  // 왕십리 근처 → 성수(약 2km) 포함, 부산 해운대 제외, 지역 없는 배송형은 위치 미상
  const near = await q({ lat: '37.561', lng: '127.037', radius: '10' });
  assert.deepEqual(near.records.map(r => r.id), ['reviewnote:1']);
  assert.ok(near.records[0].distanceKm > 0 && near.records[0].distanceKm < 10);
  assert.equal(near.records[0].lat, undefined, 'raw coordinates are not sent');
  assert.equal(near.near.unlocated, 1);
  const withNoLoc = await q({ lat: '37.561', lng: '127.037', radius: '10', noloc: '1' });
  assert.deepEqual(withNoLoc.records.map(r => r.id).sort(), ['bqueens:3', 'reviewnote:1']);
  const wide = await q({ lat: '37.561', lng: '127.037', radius: '100', sort: 'distance' });
  assert.deepEqual(wide.records.map(r => r.id), ['reviewnote:1'], '부산 is ~325km away');
  const bad = await q({ lat: '10', lng: '10', radius: '10' });
  assert.equal(bad.near, null, 'out-of-Korea point ignored');
  assert.equal(bad.total, 3);
  const place = await (await ctx.req('/api/geo/resolve?q=' + encodeURIComponent('수원 영통'))).json();
  assert.match(place.label, /영통구/);
  assert.equal((await ctx.req('/api/geo/resolve?q=' + encodeURIComponent('없는동네이름'))).status, 404);
});

test('precise store coordinates override centroids; unknown stores keep the centroid', async t => {
  const queued = [];
  const SEONGSU_STORE = { s: 'hit', lat: 37.5446, lng: 127.0557, name: '서울 카페 성수점', url: 'https://place.map.kakao.com/123' };
  const places = {
    keyFor: (r, g) => (r.type === '방문형' ? `${r.region_sido}|${g.label}|${r.title}` : null),
    get: k => (k && k.endsWith('서울 카페') ? SEONGSU_STORE : null),
    enqueue: items => queued.push(...items),
    anchor: async q => (q === '왕십리역' ? { lat: 37.5612, lng: 127.0371, level: 'place', label: '왕십리역 2호선' } : null),
    stats: () => ({ state: 'ok', located: 1, pending: 0 })
  };
  const ctx = await start(t, { places });
  const near = await (await ctx.req('/api/campaigns?' + new URLSearchParams({ lat: '37.561', lng: '127.037', radius: '100', sort: 'distance' }))).json();
  const r = near.records.find(x => x.id === 'reviewnote:1');
  assert.equal(r.geoLevel, 'place');
  assert.equal(r.placeName, '서울 카페 성수점');
  assert.equal(r.placeUrl, 'https://place.map.kakao.com/123');
  assert.equal(r.distanceKm, 2.5, 'distance to the store, not the 성수 centroid');
  for (const f of ['lat', 'lng', 'placeKey', 'geoLabel']) assert.equal(r[f], undefined, f + ' stays server-side');
  assert.deepEqual(near.places, { state: 'ok', located: 1, pending: 0 });
  // only recent, open visit campaigns are queued for lookup
  assert.deepEqual(queued.map(i => i.record.id).sort(), ['dinnerqueen:2', 'reviewnote:1']);
  assert.ok(queued.every(i => i.centroid.lat && i.centroid.label));
  // typed landmark the region table does not know
  const anchor = await (await ctx.req('/api/geo/resolve?q=' + encodeURIComponent('왕십리역'))).json();
  assert.equal(anchor.label, '왕십리역 2호선');
  // region names still resolve locally first (no Kakao call)
  assert.match((await (await ctx.req('/api/geo/resolve?q=' + encodeURIComponent('수원 영통'))).json()).label, /영통구/);
});

test('validateNickname: trim, 2-20 chars, no control/invisible chars, HTML kept as plain text', () => {
  const { validateNickname } = require('./server.js');
  assert.deepEqual(validateNickname('  모아   체험　러 '), { nickname: '모아 체험 러' });
  assert.deepEqual(validateNickname('가나'), { nickname: '가나' });
  assert.deepEqual(validateNickname('가'.repeat(20)), { nickname: '가'.repeat(20) });
  assert.ok(validateNickname('가'.repeat(21)).error);
  assert.ok(validateNickname(' 가 ').error, 'one char after trim');
  assert.ok(validateNickname('').error);
  assert.ok(validateNickname(null).error);
  assert.ok(validateNickname(123).error);
  assert.ok(validateNickname('줄\n바꿈').error, 'newline');
  assert.ok(validateNickname('탭\t문자').error, 'tab');
  assert.ok(validateNickname('abc‮def').error, 'bidi override');
  assert.ok(validateNickname('zero​width').error, 'zero-width space');
  assert.deepEqual(validateNickname('가족👨‍👩‍👧'), { nickname: '가족👨‍👩‍👧' }, 'emoji ZWJ sequence allowed');
  assert.deepEqual(validateNickname('<b>봉</b>'), { nickname: '<b>봉</b>' }, 'stored as text, escaped on render');
  assert.deepEqual(validateNickname('가'.repeat(18) + '😀😀'), { nickname: '가'.repeat(18) + '😀😀' }, 'counts characters, not UTF-16 units');
});

test('nickname: set via API, shown in every session, survives logout/re-login and restart, duplicates allowed', async t => {
  const fetchOpts = { me: { id: 42, kakao_account: {} } }; // Kakao profile without a nickname
  const ctx = await start(t, { env: KAKAO_ENV, fetchOpts });
  const put = (body, h) => ctx.req('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await put({ nickname: '봉봉' }, {})).status, 401, 'login required');
  assert.equal((await ctx.req('/api/profile')).status, 401);

  const a = (await loginFlow(ctx)).sidCookie;
  const b = (await loginFlow(ctx)).sidCookie; // second device, same account
  const me = async sid => (await (await ctx.req('/api/me', { headers: { cookie: sid } })).json()).user;
  assert.deepEqual(await me(a), { id: 'kakao:42', nickname: '카카오 사용자', nicknameSet: false, kakaoNickname: null, isAdmin: false });

  for (const [body, code] of [['not json', 'bad_body'], [{ nickname: '가' }, 'bad_nickname'], [{ nickname: 'x'.repeat(21) }, 'bad_nickname'], [{ nickname: 'a‮b c' }, 'bad_nickname'], [{}, 'bad_nickname']]) {
    const r = await put(body, { cookie: a });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, code);
  }
  assert.equal((await put({ nickname: '봉봉' }, { cookie: a, origin: 'https://evil.example' })).status, 403, 'cross-origin write blocked');

  const saved = await put({ nickname: '  <i>봉봉</i>  ' }, { cookie: a });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).user, { id: 'kakao:42', nickname: '<i>봉봉</i>', nicknameSet: true, kakaoNickname: null, isAdmin: false });
  assert.equal((await me(b)).nickname, '<i>봉봉</i>', 'other open session sees the new nickname at once');
  assert.equal((await (await ctx.req('/api/profile', { headers: { cookie: b } })).json()).user.nickname, '<i>봉봉</i>');

  await ctx.req('/auth/logout', { method: 'POST', headers: { cookie: a } });
  assert.equal(await me(a), null);
  const c = (await loginFlow(ctx)).sidCookie;
  assert.equal((await me(c)).nickname, '<i>봉봉</i>', 'kept after re-login');
  assert.equal((await me(c)).nicknameSet, true);

  // another account may use the same nickname
  fetchOpts.me = { id: 77, kakao_account: { profile: { nickname: '카톡이름' } } };
  const other = (await loginFlow(ctx)).sidCookie;
  assert.deepEqual(await me(other), { id: 'kakao:77', nickname: '카톡이름', nicknameSet: false, kakaoNickname: '카톡이름', isAdmin: false });
  assert.equal((await put({ nickname: '<i>봉봉</i>' }, { cookie: other })).status, 200);
  assert.equal((await me(other)).nickname, '<i>봉봉</i>');
  assert.equal((await me(c)).id, 'kakao:42');

  // file store persists across a server restart (sessions are memory-only in file mode)
  await ctx.app.flush();
  const stored = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'data', 'profiles.json'), 'utf8'));
  assert.equal(stored['kakao:42'].nickname, '<i>봉봉</i>');
  assert.equal(stored['kakao:77'].nickname, '<i>봉봉</i>');
  fetchOpts.me = { id: 42, kakao_account: {} };
  const restarted = await start(t, { env: KAKAO_ENV, fetchOpts, dir: ctx.dir });
  const d = (await loginFlow(restarted)).sidCookie;
  assert.equal((await (await restarted.req('/api/me', { headers: { cookie: d } })).json()).user.nickname, '<i>봉봉</i>');
});

test('parseAdminIds: only numeric Kakao ids from the env list', () => {
  assert.deepEqual([...parseAdminIds(' kakao:42, 77\n123abc,운영자,,kakao:x, 0x9 ')], ['kakao:42', 'kakao:77']);
  assert.equal(parseAdminIds(undefined).size, 0);
  assert.equal(parseAdminIds('').size, 0);
});

test('admin: ADMIN_KAKAO_IDS only; /admin and dashboard 401/403/200; nickname never grants access', async t => {
  const fetchOpts = { me: { id: 42, kakao_account: { profile: { nickname: '운영자' } } } };
  const ctx = await start(t, { env: { ...KAKAO_ENV, ADMIN_KAKAO_IDS: 'kakao:42' }, fetchOpts });
  const me = async sid => (await (await ctx.req('/api/me', { headers: { cookie: sid } })).json()).user;

  let r = await ctx.req('/admin');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const anonPage = await r.text();
  assert.ok(!anonPage.includes('admin-shell') && anonPage.includes('/auth/kakao/login?return=%2Fadmin'), 'login link, no dashboard shell');
  r = await ctx.req('/api/admin/dashboard');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'login_required');

  const admin = (await loginFlow(ctx)).sidCookie;
  assert.deepEqual(await me(admin), { id: 'kakao:42', nickname: '운영자', nicknameSet: false, kakaoNickname: '운영자', isAdmin: true });
  r = await ctx.req('/admin', { headers: { cookie: admin } });
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('admin-shell'));
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await ctx.req('/admin/', { headers: { cookie: admin } })).status, 200);
  assert.equal((await ctx.req('/api/admin/dashboard?days=7', { headers: { cookie: admin } })).status, 200);
  assert.equal((await ctx.req('/api/admin/dashboard?days=10', { headers: { cookie: admin } })).status, 400);
  assert.equal((await ctx.req('/api/admin/dashboard', { method: 'POST', headers: { cookie: admin } })).status, 405);

  // a regular account, even one that copies the owner's nickname or claims isAdmin, stays a regular account
  fetchOpts.me = { id: 77, properties: { nickname: '운영자' } };
  const user = (await loginFlow(ctx)).sidCookie;
  assert.equal((await me(user)).isAdmin, false);
  const put = body => ctx.req('/api/profile', { method: 'PUT', headers: { cookie: user, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put({ nickname: '관리자', isAdmin: true, id: 'kakao:42' })).status, 200);
  assert.deepEqual(await me(user), { id: 'kakao:77', nickname: '관리자', nicknameSet: true, kakaoNickname: '운영자', isAdmin: false });
  r = await ctx.req('/admin', { headers: { cookie: user } });
  assert.equal(r.status, 403);
  assert.ok(!(await r.text()).includes('admin-shell'));
  r = await ctx.req('/api/admin/dashboard?days=30', { headers: { cookie: user } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'forbidden');
  assert.equal((await me(admin)).nickname, '운영자', 'admin nickname untouched by the other account');
  assert.equal((await me(admin)).isAdmin, true);

  // the admin keeps the normal nickname feature
  const adminPut = await ctx.req('/api/profile', { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ nickname: '봉 운영' }) });
  assert.equal(adminPut.status, 200);
  assert.equal((await adminPut.json()).user.isAdmin, true);

  // no first-user promotion: without the env nobody is an admin, including the first account
  fetchOpts.me = { id: 42, kakao_account: {} };
  const bare = await start(t, { env: KAKAO_ENV, fetchOpts });
  const first = (await loginFlow(bare)).sidCookie;
  assert.equal((await (await bare.req('/api/me', { headers: { cookie: first } })).json()).user.isAdmin, false);
  assert.equal((await bare.req('/admin', { headers: { cookie: first } })).status, 403);
  assert.equal((await bare.req('/api/admin/dashboard', { headers: { cookie: first } })).status, 403);
});

test('metrics: original-open clicks and logged-in visits; list views not counted; 7/30 days; persisted; no private data', async t => {
  let clock = NOW;
  const fetchOpts = { me: { id: 42, kakao_account: { profile: { nickname: '운영자' } } } };
  const ctx = await start(t, { env: { ...KAKAO_ENV, ADMIN_KAKAO_IDS: '42' }, fetchOpts, now: () => clock });
  const me = async (c, sid) => (await (await c.req('/api/me', { headers: { cookie: sid } })).json()).user;
  const open = (c, body, headers = {}) => c.req('/api/events/open', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const dash = async (c, sid, days = 7) => (await c.req(`/api/admin/dashboard?days=${days}`, { headers: { cookie: sid } })).json();

  // anonymous visitors can open originals; the click is counted (only the id is taken from the client)
  assert.equal((await open(ctx, { id: 'reviewnote:1' })).status, 204);
  assert.equal((await open(ctx, { id: 'reviewnote:1', title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' })).status, 204);
  for (const [body, status] of [[{ id: '<script>' }, 400], [{ id: 'manual:abc' }, 400], [{ id: 'reviewnote:999' }, 404], ['not json', 400], [{}, 400], [{ id: 'reviewnote:' + 'a'.repeat(200) }, 400]]) {
    assert.equal((await open(ctx, body)).status, status, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await open(ctx, { id: 'reviewnote:1' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await ctx.req('/api/events/open')).status, 405);

  // listing campaigns many times is not a view
  for (let i = 0; i < 3; i++) assert.equal((await ctx.req('/api/campaigns')).status, 200);

  const admin = (await loginFlow(ctx)).sidCookie; // a login alone is not a visit; /api/me is
  await me(ctx, admin); await me(ctx, admin); // same visit (within 30 minutes)
  fetchOpts.me = { id: 77, properties: { nickname: '<b>일반</b>' } };
  const user = (await loginFlow(ctx)).sidCookie;
  await me(ctx, user);
  assert.equal((await open(ctx, { id: 'dinnerqueen:2' }, { cookie: user })).status, 204);
  assert.equal((await open(ctx, { id: 'reviewnote:1' }, { cookie: user })).status, 204);
  clock += 31 * 60 * 1000; // a new visit
  await Promise.all(Array.from({ length: 5 }, () => me(ctx, admin))); // concurrent loads count once

  let d = await dash(ctx, admin);
  assert.equal(d.days, 7);
  assert.equal(d.collectingSince, new Date(NOW).toISOString());
  assert.deepEqual(d.range, { from: '2026-11-07', to: '2026-11-13' });
  assert.match(d.definitions.open, /원본 열기/);
  assert.deepEqual(d.totals, { registeredUsers: 2, activeUsers: 2, newUsers: 2, visits: 3, opens: 4, openedCampaigns: 2 });
  assert.deepEqual(d.campaigns, [
    { id: 'reviewnote:1', title: '서울 카페', source: 'reviewnote', url: 'https://a/1', opens: 3, opensAllTime: 3 },
    { id: 'dinnerqueen:2', title: '부산 맛집', source: 'dinnerqueen', url: 'https://a/2', opens: 1, opensAllTime: 1 }
  ]);
  const byNick = Object.fromEntries(d.users.map(u => [u.nickname, u]));
  assert.deepEqual(byNick['운영자'], { nickname: '운영자', nicknameSet: false, admin: true, firstVisit: new Date(NOW).toISOString(), lastVisit: new Date(clock).toISOString(), visits: 2, visitsInRange: 2 });
  assert.equal(byNick['<b>일반</b>'].visits, 1, 'nickname is returned as plain data');
  const raw = JSON.stringify(d);
  for (const secret of ['kakao:42', 'kakao:77', admin.split('=')[1], user.split('=')[1], 'tok-abc', '127.0.0.1', 'javascript:', 'onerror', 'email', '"ip"']) {
    assert.ok(!raw.includes(secret), `dashboard must not contain ${secret}`);
  }

  // saved nickname replaces the Kakao one in the dashboard
  await ctx.req('/api/profile', { method: 'PUT', headers: { cookie: user, 'content-type': 'application/json' }, body: JSON.stringify({ nickname: '체험러' }) });
  assert.ok((await dash(ctx, admin)).users.some(u => u.nickname === '체험러' && u.nicknameSet && !u.admin));

  // file mode survives a restart, and no session/token/address is written to disk
  await ctx.app.flush();
  const disk = fs.readFileSync(path.join(ctx.dir, 'data', 'metrics.json'), 'utf8');
  assert.ok(!disk.includes(admin.split('=')[1]) && !disk.includes('tok-abc') && !disk.includes('127.0.0.1'));
  clock += 8 * 24 * 3600 * 1000; // sessions expire after 7 days, so log in again
  fetchOpts.me = { id: 42, kakao_account: { profile: { nickname: '운영자' } } };
  const restarted = await start(t, { env: { ...KAKAO_ENV, ADMIN_KAKAO_IDS: '42' }, fetchOpts, now: () => clock, dir: ctx.dir });
  const again = (await loginFlow(restarted)).sidCookie;
  d = await dash(restarted, again, 7);
  assert.equal(d.collectingSince, new Date(NOW).toISOString(), 'start date kept');
  assert.equal(d.totals.opens, 0, 'older clicks fall out of the 7-day window');
  assert.equal(d.totals.newUsers, 0);
  d = await dash(restarted, again, 30);
  assert.equal(d.totals.opens, 4);
  assert.equal(d.campaigns[0].opensAllTime, 3);
  assert.equal(d.totals.registeredUsers, 2);
  assert.equal(d.users.find(u => u.admin).visits, 2, 'visit counts kept across restart');
});

test('validatePreferences: types, lengths, counts, coordinates, radius and sort', () => {
  const { validatePreferences } = require('./preferences.js');
  const ok = validatePreferences({ categories: ['카페', '카페', ' 맛집 '], sources: ['reviewnote'], channels: ['블로그'], regions: ['서울'], q: '  성수   카페 ', near: { label: '현재 위치', lat: 37.5445678, lng: 127.0567891 }, radius: 5, includeNoLoc: true, sort: 'distance', userId: 'kakao:1' });
  assert.deepEqual(ok.preferences, { categories: ['카페', '맛집'], sources: ['reviewnote'], channels: ['블로그'], regions: ['서울'], q: '성수 카페', near: { label: '현재 위치', lat: 37.545, lng: 127.057 }, radius: 5, includeNoLoc: true, sort: 'distance' });
  assert.deepEqual(validatePreferences({}).preferences, { categories: [], sources: [], channels: [], regions: [], q: '', near: null, radius: 10, includeNoLoc: false, sort: 'deadline' });
  for (const bad of [null, [], 'x', { categories: 'x' }, { categories: [1] }, { categories: Array(31).fill('a').map((a, i) => a + i) }, { regions: ['a'.repeat(61)] }, { regions: [''] },
    { sources: ['<script>'] }, { q: 'a'.repeat(101) }, { q: 'a‮b' }, { q: 5 }, { near: { label: 'x', lat: 10, lng: 127 } }, { near: { label: 'x', lat: 37.5, lng: 200 } },
    { near: { label: '', lat: 37.5, lng: 127 } }, { near: { label: 'x', lat: '37', lng: 127 } }, { near: [] }, { radius: 7 }, { radius: '10' }, { includeNoLoc: 'yes' }, { sort: 'popular' }]) {
    assert.ok(validatePreferences(bad).error, JSON.stringify(bad).slice(0, 60));
  }
});

test('preferences: per account, session only, validated, reset saved, survive re-login and restart', async t => {
  const fetchOpts = { me: { id: 42, kakao_account: { profile: { nickname: '봉' } } } };
  const ctx = await start(t, { env: { ...KAKAO_ENV, ADMIN_KAKAO_IDS: '42' }, fetchOpts });
  const get = sid => ctx.req('/api/preferences', { headers: { cookie: sid } });
  const put = (sid, preferences, headers = {}) => ctx.req('/api/preferences', { method: 'PUT', headers: { cookie: sid, 'content-type': 'application/json', ...headers }, body: typeof preferences === 'string' ? preferences : JSON.stringify({ preferences }) });
  const A = { categories: ['카페'], sources: ['reviewnote', 'dinnerqueen'], channels: ['블로그', '인스타그램'], regions: [], q: '성수', near: { label: '현재 위치', lat: 37.5446123, lng: 127.0559876 }, radius: 5, includeNoLoc: true, sort: 'distance' };
  const savedA = { ...A, near: { label: '현재 위치', lat: 37.545, lng: 127.056 } };

  assert.equal((await ctx.req('/api/preferences')).status, 401);
  assert.equal((await put('', A)).status, 401);

  const a1 = (await loginFlow(ctx)).sidCookie;
  assert.deepEqual(await (await get(a1)).json(), { preferences: null }, 'never saved');
  assert.equal((await put(a1, A, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await put(a1, 'nope')).status, 400);
  const bad = await put(a1, { ...A, radius: 7 });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'bad_preferences');
  assert.equal((await ctx.req('/api/preferences', { method: 'POST', headers: { cookie: a1 } })).status, 405);
  assert.deepEqual(await (await get(a1)).json(), { preferences: null }, 'rejected writes stored nothing');

  // the account comes from the session only; a userId in the body or a mismatched X-Moa-Account never redirects the write
  const r = await put(a1, { ...A, userId: 'kakao:77' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).preferences, savedA, 'GPS coordinates stored at 3 decimals');
  assert.equal((await put(a1, { q: 'x' }, { 'x-moa-account': 'kakao:77' })).status, 409);
  // a tab that still thinks it is another account cannot read this account's filters either
  const stale = await ctx.req('/api/preferences', { headers: { cookie: a1, 'x-moa-account': 'kakao:77' } });
  assert.equal(stale.status, 409);
  assert.ok(!(await stale.text()).includes('성수'));
  assert.equal((await ctx.req('/api/preferences', { headers: { cookie: a1, 'x-moa-account': 'kakao:42' } })).status, 200);
  assert.deepEqual((await (await get(a1)).json()).preferences, savedA, '409 wrote nothing');

  // another session of the same account and a re-login see the same filters
  const a2 = (await loginFlow(ctx)).sidCookie;
  assert.deepEqual((await (await get(a2)).json()).preferences, savedA);
  await ctx.req('/auth/logout', { method: 'POST', headers: { cookie: a1 } });
  assert.equal((await get(a1)).status, 401);

  // account B is separate and starts empty (nothing copied from A)
  fetchOpts.me = { id: 77, properties: { nickname: '다른' } };
  const b = (await loginFlow(ctx)).sidCookie;
  assert.deepEqual(await (await get(b)).json(), { preferences: null });
  assert.equal((await put(b, { regions: ['부산'] }, { 'x-moa-account': 'kakao:77' })).status, 200);
  assert.deepEqual((await (await get(a2)).json()).preferences, savedA, 'B did not touch A');

  // explicit reset is saved as the empty filter
  assert.equal((await put(a2, {})).status, 200);
  const empty = { categories: [], sources: [], channels: [], regions: [], q: '', near: null, radius: 10, includeNoLoc: false, sort: 'deadline' };
  assert.deepEqual((await (await get(a2)).json()).preferences, empty);
  assert.equal((await put(a2, A)).status, 200);

  // nickname, admin and favorites are unaffected
  const me = await (await ctx.req('/api/me', { headers: { cookie: a2 } })).json();
  assert.equal(me.user.nickname, '봉');
  assert.equal(me.user.isAdmin, true);
  assert.equal((await ctx.req('/api/profile', { method: 'PUT', headers: { cookie: a2, 'content-type': 'application/json' }, body: JSON.stringify({ nickname: '봉봉' }) })).status, 200);
  assert.deepEqual((await (await get(a2)).json()).preferences, savedA, 'nickname change keeps filters');

  // file mode persists across a restart
  await ctx.app.flush();
  const disk = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'data', 'preferences.json'), 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['kakao:42', 'kakao:77']);
  assert.ok(!JSON.stringify(disk).includes('37.5446123'), 'raw coordinates never written');
  fetchOpts.me = { id: 42, kakao_account: {} };
  const restarted = await start(t, { env: KAKAO_ENV, fetchOpts, dir: ctx.dir });
  const a3 = (await loginFlow(restarted)).sidCookie;
  assert.deepEqual((await (await restarted.req('/api/preferences', { headers: { cookie: a3 } })).json()).preferences, savedA);
  assert.equal((await (await restarted.req('/api/me', { headers: { cookie: a3 } })).json()).user.nickname, '봉봉');
});
