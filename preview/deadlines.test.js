'use strict';
// Run: node --test preview/deadlines.test.js   (no network: every original page is a local fixture)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { parseDinnerqueen, robotsAllows, createDeadlineVerifier } = require('./deadlines.js');
const { createApp } = require('./server.js');

// trimmed copy of the structure of a dinnerqueen.net/taste/<id> page (labels row, values row, calendar script)
function page({ start = '26.11.09', end = '26.11.15', ann = '26.11.16', sStart = '2026-11-09', sEnd = '2026-11-16', copies = 2, block } = {}) {
  const table = block || `<div><h6><strong>신청 기간</strong></h6><h6><strong>발표 날짜</strong></h6><h6><strong>리뷰 기간</strong></h6></div>
<div><p><strong>${start} – ${end}</strong></p><p>${ann}</p><p>26.11.17 – 26.12.01</p></div>`;
  return `<!doctype html><html><head><script type="application/ld+json">{"@type":"Organization","name":"디너의여왕"}</script></head><body>
${Array(copies).fill(table).join('\n')}
<strong>신청 마감까지 <span class="color-primary-dq">2</span>일 남았습니다.</strong>
<script>calendar({ events: [ { title: '신청', start: '${sStart}', end: '${sEnd}', className: 'step01' }, { title: '발표', start: '2026-11-16', end: '2026-11-16' }, { title: '리뷰', start: '2026-11-17', end: '2026-12-02' } ] });
var countDownDate = new Date("2026-11-16").getTime();</script></body></html>`;
}

test('parseDinnerqueen: accepts only a table period that matches the calendar script (end exclusive)', () => {
  assert.deepEqual(parseDinnerqueen(page()), { start: '2026-11-09', end: '2026-11-15', evidence: '신청 기간 26.11.09 – 26.11.15' });
  // across the year boundary, with the year taken from the page itself
  assert.deepEqual(parseDinnerqueen(page({ start: '26.12.28', end: '27.01.03', ann: '27.01.04', sStart: '2026-12-28', sEnd: '2027-01-04' })).end, '2027-01-03');
  // end of February / leap day
  assert.equal(parseDinnerqueen(page({ start: '28.02.20', end: '28.02.29', ann: '28.03.01', sStart: '2028-02-20', sEnd: '2028-03-01' })).end, '2028-02-29');
  const fails = {
    'script end not exclusive': [page({ sEnd: '2026-11-15' }), 'mismatch'],
    'script start differs': [page({ sStart: '2026-11-08' }), 'mismatch'],
    'impossible date': [page({ end: '26.02.30', sEnd: '2026-03-01' }), 'unparsed'],
    'impossible script date': [page({ sEnd: '2026-13-01' }), 'unparsed'],
    'announcement before deadline': [page({ ann: '26.11.14' }), 'mismatch'],
    'start after end': [page({ start: '26.11.20', sStart: '2026-11-20' }), 'mismatch'],
    'copies disagree': [page({ copies: 1 }) + page({ end: '26.11.14', sEnd: '2026-11-15', copies: 1 }), 'mismatch'],
    'no calendar script': [page().replace(/title: '신청'/, "title: '모집'"), 'unparsed'],
    'labels changed': [page().replace(/신청 기간/g, '모집 기간'), 'unparsed'],
    'label order changed (리뷰 first)': [page({ block: '<p>리뷰 기간 발표 날짜 신청 기간</p><p>26.11.09 – 26.11.15 26.11.16</p>' }), 'unparsed'],
    'only a countdown': ['<script>var countDownDate = new Date("2026-11-16")</script>신청 마감까지 2일', 'unparsed'],
    'empty': ['', 'unparsed']
  };
  for (const [name, [html, error]] of Object.entries(fails)) assert.deepEqual(parseDinnerqueen(html), { error }, name);
});

test('robotsAllows: our agent group, then *, longest rule wins', () => {
  const dq = 'User-agent: Yeti\nCrawl-delay: 30\nDisallow: /search\nDisallow: /*?*\n\nUser-agent: *\nAllow: /';
  assert.equal(robotsAllows(dq, '/taste/1'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /taste/', '/taste/1'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nAllow: /taste/', '/taste/1'), true);
  assert.equal(robotsAllows('User-agent: MoaExperienceBot\nDisallow: /\n\nUser-agent: *\nAllow: /', '/taste/1'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow:', '/taste/1'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*1$', '/taste/1'), false);
});

// fake origin: records every request; pages by numeric id
function fakeOrigin(pages, { robots = 'User-agent: *\nAllow: /', status = {}, type = 'text/html; charset=UTF-8' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), redirect: init.redirect, ua: init.headers['User-Agent'] });
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => robots };
    const id = u.pathname.split('/').pop();
    if (status[id]) return { status: status[id], headers: new Headers({ location: 'https://evil.example/' }), text: async () => '' };
    return { status: 200, headers: new Headers({ 'content-type': type }), text: async () => pages[id] ?? '' };
  };
  return { calls, fetchImpl };
}

// fake clock shared by data time and the request budget: sleeping advances both
function clockKit(start = Date.parse('2026-11-13T03:00:00Z')) {
  const k = { t: start, mono: 0 };
  k.now = () => k.t;
  k.monotonic = () => k.mono;
  k.sleep = async ms => { k.t += ms; k.mono += ms; };
  return k;
}

test('verifier: fractional remaining request budgets produce valid integer abort timeouts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-fraction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = fakeOrigin({ 1: page() });
  const v = createDeadlineVerifier({ filePath: path.join(dir, 'cache.json'), fetch: origin.fetchImpl, monotonic: () => 0.25, intervalMs: 0 });
  const result = await v.verifyOne({ id: 'dinnerqueen:1', source: 'dinnerqueen', precision: 'days_left' }, { deadlineAt: 1500 });
  assert.equal(result.status, 'verified');
  assert.equal(origin.calls.length, 2, 'robots and original page both requested within the budget');
});

test('verifier: canonical URL, no redirects, robots per path, waits for its slot, cache, failures keep the estimate', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const k = clockKit();
  const origin = fakeOrigin({ 1: page(), 2: page({ sEnd: '2026-11-15' }), 4: 'x'.repeat(1024 * 1024 + 1), 8: page() },
    { status: { 3: 301 }, robots: 'User-agent: Yeti\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /taste/7' });
  const make = (opts = {}) => createDeadlineVerifier({ filePath: path.join(dir, 'deadlines.json'), fetch: origin.fetchImpl, now: k.now, monotonic: k.monotonic, sleep: k.sleep, intervalMs: 1000, ...opts });
  const v = make();
  const rec = (n, extra = {}) => ({ id: `dinnerqueen:${n}`, source: 'dinnerqueen', url: `https://evil.example/${n}`, precision: 'days_left', deadline: '2026-11-20', ...extra });

  assert.equal(v.supports(rec(1)), true);
  assert.equal(v.supports(rec(1, { precision: 'exact' })), false, 'already exact');
  assert.equal(v.supports({ id: 'reviewnote:1', source: 'reviewnote' }), false);
  assert.equal(v.supports(rec('1/../x')), false, 'numeric ids only');

  // first check: robots, then it waits one second for the next slot and fetches the page
  const start = k.t;
  const e1 = await v.verifyOne(rec(1));
  assert.ok(k.t - start >= 1000, 'requests spaced by 1 s');
  assert.deepEqual({ status: e1.status, deadline: e1.deadline, start: e1.start, evidence: e1.evidence, url: e1.url },
    { status: 'verified', deadline: '2026-11-15', start: '2026-11-09', evidence: '신청 기간 26.11.09 – 26.11.15', url: 'https://dinnerqueen.net/taste/1' });
  assert.deepEqual(origin.calls.map(c => c.url), ['https://dinnerqueen.net/robots.txt', 'https://dinnerqueen.net/taste/1'], 'canonical host/path, never the record URL');
  assert.ok(origin.calls.every(c => c.redirect === 'manual' && /MoaExperienceBot/.test(c.ua)));
  assert.equal(v.apply(rec(1), await v.verifiedMap()).precision, 'exact_date');
  assert.equal(v.apply(rec(1), await v.verifiedMap()).deadline, '2026-11-15');
  assert.equal((await v.verifyOne(rec(1))).checkedAt, e1.checkedAt, 'cached, no new request');
  assert.equal(origin.calls.length, 2);

  // robots rules are evaluated for each candidate path
  assert.deepEqual(await v.verifyOne(rec(7)), { status: 'deferred', reason: 'robots_disallow' });
  assert.equal((await v.verifyOne(rec(8))).status, 'verified');
  assert.ok(!origin.calls.some(c => c.url.endsWith('/taste/7')));

  for (const [n, status] of [[2, 'mismatch'], [3, 'error'], [4, 'error']]) {
    assert.equal((await v.verifyOne(rec(n))).status, status, `page ${n}`);
    assert.equal(v.apply(rec(n), await v.verifiedMap()).precision, 'days_left', 'estimate kept');
  }
  // the cache file holds robots rules and short evidence, never page HTML
  await v.flush();
  const disk = fs.readFileSync(path.join(dir, 'deadlines.json'), 'utf8');
  assert.ok(!disk.includes('<') && !disk.includes('countDownDate') && disk.includes('신청 기간 26.11.09 – 26.11.15') && disk.includes('Disallow: /taste/7'));
  // persisted across a restart; expired entries are re-checked after 6 hours
  const again = make();
  assert.equal((await again.verifiedMap()).get('dinnerqueen:1').deadline, '2026-11-15');
  k.t += 6 * 3600e3 + 1;
  assert.equal((await again.verifiedMap()).size, 0);
});

test('verifier: robots HTML/challenge or server error = unknown policy, no page request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ['html challenge', 200, 'text/html', '<html><body>Just a moment...</body></html>'],
    ['html as text/plain', 200, 'text/plain', '<!DOCTYPE html><title>blocked</title>'],
    ['server error', 503, 'text/plain', '']
  ];
  for (const [name, status, type, body] of cases) {
    const calls = [];
    const k = clockKit();
    const fetchImpl = async url => {
      calls.push(String(url));
      if (String(url).endsWith('robots.txt')) return { status, headers: new Headers({ 'content-type': type }), text: async () => body };
      return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => page() };
    };
    const v = createDeadlineVerifier({ filePath: path.join(dir, name.replace(/\W/g, '') + '.json'), fetch: fetchImpl, now: k.now, monotonic: k.monotonic, sleep: k.sleep });
    assert.deepEqual(await v.verifyOne({ id: 'dinnerqueen:1', source: 'dinnerqueen', precision: 'days_left' }), { status: 'deferred', reason: 'robots_unknown' }, name);
    assert.deepEqual(calls, ['https://dinnerqueen.net/robots.txt'], name);
  }
});

test('verifier: budget, daily cap and concurrency; verifySome takes at most 3, visible first, all within the call', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pages = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, page()]));
  const rec = n => ({ id: `dinnerqueen:${n}`, source: 'dinnerqueen', precision: 'days_left', deadline: '2026-11-20' });
  const pageCalls = calls => calls.filter(c => c.url.includes('/taste/')).map(c => c.url.split('/').pop());

  // 1.5 s budget with 1 s spacing: robots now, one page after 1 s, then the budget ends; the reason is reported
  const k = clockKit();
  const slow = fakeOrigin(pages);
  const v = createDeadlineVerifier({ filePath: path.join(dir, 'b.json'), fetch: slow.fetchImpl, now: k.now, monotonic: k.monotonic, sleep: k.sleep, intervalMs: 1000 });
  assert.deepEqual(await v.verifySome([rec(1), rec(2), rec(3)], { budgetMs: 1500 }), { candidates: 3, verified: 1, addresses: 0, checked: 1, deferred: 'budget' });
  assert.deepEqual(pageCalls(slow.calls), ['1']);
  assert.deepEqual(await v.verifySome([rec(1), rec(2), rec(3)], { budgetMs: 2500 }), { candidates: 2, verified: 2, addresses: 0, checked: 2, deferred: null });

  // daily cap
  const k2 = clockKit();
  const capped = fakeOrigin(pages);
  const c = createDeadlineVerifier({ filePath: path.join(dir, 'c.json'), fetch: capped.fetchImpl, now: k2.now, monotonic: k2.monotonic, sleep: k2.sleep, intervalMs: 0, dailyCap: 2 });
  assert.deepEqual(await c.verifySome([rec(5), rec(6), rec(7)]), { candidates: 3, verified: 1, addresses: 0, checked: 1, deferred: 'cap' });

  // concurrency and order
  const k3 = clockKit();
  const origin = fakeOrigin(pages);
  const w = createDeadlineVerifier({ filePath: path.join(dir, 'd.json'), fetch: origin.fetchImpl, now: k3.now, monotonic: k3.monotonic, sleep: k3.sleep, intervalMs: 0 });
  await Promise.all([w.verifyOne(rec(1)), w.verifyOne(rec(1)), w.verifyOne(rec(1))]);
  assert.deepEqual(pageCalls(origin.calls), ['1'], 'one fetch per campaign');
  const r = await w.verifySome([rec(5), { id: 'reviewnote:9', source: 'reviewnote' }, rec(1), rec(4), rec(3), rec(2)]);
  assert.deepEqual(r, { candidates: 3, verified: 3, addresses: 0, checked: 3, deferred: null });
  assert.deepEqual(pageCalls(origin.calls), ['1', '5', '4', '3'], 'order kept, verified skipped, max 3');
});

async function listServer(t, appOptions) {
  const app = createApp(appOptions);
  const server = http.createServer(app.handler);
  for (let attempt = 1; ; attempt++) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); break; }
    catch (err) { if (err.code !== 'EFAULT' || attempt >= 10) throw err; await new Promise(r => setTimeout(r, 100)); }
  }
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = async q => (await fetch(`${base}/api/campaigns${q || ''}`)).json();
  list.request = (route, init) => fetch(base + route, init);
  return list;
}

test('API: verified dates replace estimates before expiry filter, sort and paging; failures keep the estimate', async t => {
  const NOW = Date.parse('2026-11-13T03:00:00Z');
  const seen = new Date(NOW - 3600e3).toISOString();
  const SOURCE = [
    { id: 'dinnerqueen:1', source_id: 'dinnerqueen', title: '이미 끝남', original_url: 'https://dinnerqueen.net/taste/1', apply_deadline: '2026-11-25', deadline_precision: 'days_left', last_seen_at: seen },
    { id: 'dinnerqueen:2', source_id: 'dinnerqueen', title: '앞당겨짐', original_url: 'https://dinnerqueen.net/taste/2', apply_deadline: '2026-11-30', deadline_precision: 'days_left', last_seen_at: seen },
    { id: 'dinnerqueen:3', source_id: 'dinnerqueen', title: '불일치', original_url: 'https://dinnerqueen.net/taste/3', apply_deadline: '2026-11-21', deadline_precision: 'days_left', last_seen_at: seen },
    { id: 'reviewnote:4', source_id: 'reviewnote', title: '리뷰노트', original_url: 'https://www.reviewnote.co.kr/campaigns/4', apply_deadline: '2026-11-20', deadline_precision: 'days_left', last_seen_at: seen }
  ];
  const origin = fakeOrigin({
    1: page({ start: '26.11.01', end: '26.11.10', ann: '26.11.11', sStart: '2026-11-01', sEnd: '2026-11-11' }),
    2: page({ start: '26.11.10', end: '26.11.16', ann: '26.11.17', sStart: '2026-11-10', sEnd: '2026-11-17' }),
    3: page({ sEnd: '2026-11-20' })
  });
  const fetchImpl = async (url, init) => String(url).includes('campaigns.json')
    ? { ok: true, status: 200, json: async () => SOURCE }
    : origin.fetchImpl(url, init);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deadlines = createDeadlineVerifier({ filePath: path.join(dir, 'd.json'), fetch: origin.fetchImpl, now: () => NOW, intervalMs: 0 });
  // the checks run after the response (waitUntil); the list itself never waits for the original pages
  const later = [];
  const list = await listServer(t, { env: { KAKAO_LOCAL: '0' }, fetch: fetchImpl, now: () => NOW, favoritesPath: path.join(dir, 'fav.json'), deadlines, waitUntil: p => later.push(p) });
  const first = await list();
  assert.deepEqual(first.deadlineCheck, { mode: 'after_response', started: true });
  assert.ok(first.records.every(r => r.precision === 'days_left'), 'first response uses the estimates');
  assert.equal(first.total, 4);
  await Promise.all(later);

  const d = await list();
  assert.equal(d.total, 3, 'campaign whose verified deadline has passed is gone, total recounted');
  assert.deepEqual(d.records.map(r => [r.id, r.deadline, r.precision]), [
    ['dinnerqueen:2', '2026-11-16', 'exact_date'],
    ['reviewnote:4', '2026-11-20', 'days_left'],
    ['dinnerqueen:3', '2026-11-21', 'days_left']
  ], 'sorted by the verified date; mismatch and unsupported keep the estimate');
  const v = d.records[0];
  assert.equal(v.deadlineSource, 'https://dinnerqueen.net/taste/2');
  assert.equal(v.deadlineEvidence, '신청 기간 26.11.10 – 26.11.16');
  assert.ok(v.deadlineVerifiedAt);
  assert.ok(!origin.calls.some(c => c.url.includes('reviewnote')), 'no request to an unsupported platform');
  const pageCalls = origin.calls.filter(c => c.url.includes('/taste/')).length;
  assert.equal(pageCalls, 3);
  // the next request uses the cache: no new page requests, same answer
  const again = await list('?source=dinnerqueen');
  assert.equal(origin.calls.filter(c => c.url.includes('/taste/')).length, pageCalls);
  assert.deepEqual(again.records.map(r => r.id), ['dinnerqueen:2', 'dinnerqueen:3']);
});

test('API on serverless without waitUntil: checks run inline within the budget (nothing outlives the response)', async t => {
  const NOW = Date.parse('2026-11-13T03:00:00Z');
  const seen = new Date(NOW - 3600e3).toISOString();
  const SOURCE = [{ id: 'dinnerqueen:2', source_id: 'dinnerqueen', title: 'x', original_url: 'https://dinnerqueen.net/taste/2', apply_deadline: '2026-11-30', deadline_precision: 'days_left', last_seen_at: seen }];
  const origin = fakeOrigin({ 2: page({ start: '26.11.10', end: '26.11.16', ann: '26.11.17', sStart: '2026-11-10', sEnd: '2026-11-17' }) });
  const fetchImpl = async (url, init) => String(url).includes('campaigns.json') ? { ok: true, status: 200, json: async () => SOURCE } : origin.fetchImpl(url, init);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-inline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deadlines = createDeadlineVerifier({ filePath: path.join(dir, 'd.json'), fetch: origin.fetchImpl, now: () => NOW, intervalMs: 0 });
  const list = await listServer(t, { env: { KAKAO_LOCAL: '0', VERCEL: '1' }, fetch: fetchImpl, now: () => NOW, favoritesPath: path.join(dir, 'fav.json'), deadlines });
  const d = await list();
  assert.deepEqual(d.deadlineCheck, { candidates: 1, verified: 1, addresses: 0, checked: 1, deferred: null });
  assert.equal(d.records[0].precision, 'exact_date');
});

test('verified future date rescues a past estimate and stays consistent in favorites and marks without new origin requests', async t => {
  const NOW = Date.parse('2026-11-13T03:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-snapshots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = fakeOrigin({ 1: page({ end:'26.11.14', ann:'26.11.15', sEnd:'2026-11-15' }) });
  const verifier = createDeadlineVerifier({ filePath:path.join(dir, 'dates.json'), fetch:origin.fetchImpl, now:() => NOW, intervalMs:0 });
  await verifier.verifyOne({ id:'dinnerqueen:1', source:'dinnerqueen', precision:'days_left' });
  const originCount = origin.calls.length;
  const rows = new Map();
  const rowKey = (s, o, k) => JSON.stringify([s, o, k]);
  const store = {
    get:async (s,o,k) => rows.get(rowKey(s,o,k)) || null,
    set:async (s,o,k,v) => rows.set(rowKey(s,o,k), v),
    list:async (s,o) => Object.fromEntries([...rows].filter(([k]) => { const p=JSON.parse(k); return p[0]===s && p[1]===o; }).map(([k,v]) => [JSON.parse(k)[2],v])),
    acquire:async () => true, release:async () => {}, prune:async () => {}
  };
  await store.set('session', '', 'fixture', { user:{id:'kakao:1',nickname:'tester'}, expires:NOW+3600000 });
  const source = [{ id:'dinnerqueen:1', source_id:'dinnerqueen', title:'추정 마감이 지난 공고', apply_deadline:'2026-11-12', deadline_precision:'days_left', last_seen_at:new Date(NOW).toISOString(), original_url:'https://dinnerqueen.net/taste/1' }];
  const list = await listServer(t, { store, env:{KAKAO_LOCAL:'0'}, now:() => NOW, deadlines:verifier, fetch:async () => ({ok:true,json:async () => source}) });
  const main = await list();
  assert.equal(main.total, 1, 'source cache must not discard the record using its stale estimate');
  assert.equal(main.records[0].deadline, '2026-11-14');
  const headers = {cookie:'sid=fixture','Content-Type':'application/json'};
  const expectedFields = r => [r.deadline,r.precision,r.deadlineSource,r.deadlineEvidence,r.deadlineVerifiedAt];
  const added = await (await list.request('/api/favorites/dinnerqueen%3A1', {method:'PUT',headers})).json();
  assert.deepEqual(expectedFields(added.item), expectedFields(main.records[0]));
  // Older snapshots are corrected for display even when stored before original-page verification.
  const legacy = {...added.item,deadline:'2026-11-12',precision:'days_left'};
  delete legacy.deadlineSource; delete legacy.deadlineEvidence; delete legacy.deadlineVerifiedAt;
  await store.set('favorite','kakao:1','dinnerqueen:1',legacy);
  await store.set('favorite','kakao:1','manual:1',{...legacy,id:'manual:1',manual:true});
  const favorites = await (await list.request('/api/favorites',{headers})).json();
  assert.deepEqual(expectedFields(favorites.items.find(r=>r.id==='dinnerqueen:1')),expectedFields(main.records[0]));
  assert.equal(favorites.items.find(r=>r.manual).deadline,'2026-11-12','manual dates remain the user\'s dates');
  const marked = await (await list.request('/api/marks/dinnerqueen%3A1',{method:'PUT',headers,body:JSON.stringify({status:'excluded'})})).json();
  assert.deepEqual(expectedFields(marked.item),expectedFields(main.records[0]));
  await store.set('mark','kakao:1','dinnerqueen:1',{...legacy,status:'excluded',at:new Date(NOW).toISOString()});
  const excluded = await (await list.request('/api/marks?status=excluded',{headers})).json();
  assert.deepEqual(expectedFields(excluded.items[0]),expectedFields(main.records[0]));
  assert.equal(origin.calls.length,originCount,'snapshot writes and reads reuse known verification without original-page requests');
});
