'use strict';
// Run: node --test preview/addresses.test.js   (no network: every original page is a local fixture)
// Fixtures copy only the structure of the real pages (dinnerqueen.net/taste/<id>, gangnam-review.net/cp/?id=<id>).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { parseDinnerqueenPlace, parseGangnamPlace, streetAddress, safeMapUrl, placeFields } = require('./addresses.js');
const { createDeadlineVerifier } = require('./deadlines.js');
const { createApp } = require('./server.js');

const FOOTER = '<h3 class="blind">하단 주소 및 정보</h3><p class="dis-inline-block qz-caption-kr mr-r2 mr-b05">주소: 서울특별시 강남구 테헤란로 37길 7 (13F)</p>';
const DQ_PERIOD = `<div><h6>신청 기간</h6><h6>발표 날짜</h6><h6>리뷰 기간</h6></div><div><p>26.11.10 – 26.11.16</p><p>26.11.17</p><p>26.11.18 – 26.12.01</p></div>
<script>calendar({ events: [ { title: '신청', start: '2026-11-10', end: '2026-11-17' } ] });</script>`;
function dqPage({ address = '서울 송파구 올림픽로10길 13 1층', old = address, lat = '37.5105308821742', lng = '127.081284510084', link = 'https://naver.me/5f5RkyZV', visit = true, period = true } = {}) {
  const section = visit ? `<section><p>문자로 예약해 주세요.</p></section>
<p class="qz-body-kr mb-qz-body2-kr mr-t2 mr-b1"> <span>방문 위치</span>:
  <!-- 기존 상점관리자에서 가져오는 경우에서 실제로는 상세주소를 커스텀해서 쓰기 때문에 주석처리. ${old} -->
  ${address} </p>
<div id="map-canvas" class="dq-taste-detail__content__map layer-disabled-o"></div>
<p id="detailPlaceLink" class="dis-inline-block ver-m"> <strong class="dis-inline-block qz-body-kr--line">${link}</strong> </p>` : '<p>제품 정보</p>';
  const map = visit ? `<script>// 네이버 지도
if ($('#map-canvas').length > 0) { let position = new naver.maps.LatLng(${lat}, ${lng}); }</script>` : '';
  return `<!doctype html><html><body>${period ? DQ_PERIOD : ''}${section}${FOOTER}${map}</body></html>`;
}
function gnPage({ text = '경남 양산시 삼호동 1011 2층 초량 갈비쌈냉면 양산웅상점', loca = text, link = 'https://naver.me/5YwTCBh2', visit = true } = {}) {
  const visitBlock = visit ? `<li><dl><dt>플레이스 URL</dt><dd><div><a href="${link}" alt="업체 홈페이지 링크" target="_blank">플레이스 보러가기 &gt;</a></div></dd></dl></li>
<li><dl><dt>방문 및 예약</dt><dd> 최소 방문 2~3일 전 예약필수 <br /> 당일예약 불가 합니다.<br>
  <div id="cont_map" style="display:inline-block; width:100%; height:300px;"></div>
  <div> ${text} </div>
</dd></dl></li>` : '<li><dl><dt>제품 URL</dt><dd><a href="https://shop.example/item">제품 보기</a></dd></dl></li>';
  return `<!doctype html><html><body><ul class="detail_info">${visitBlock}</ul>
<p>회원정보 : 성명, 주소, 연락처</p>
<script>function MapLoad() { var loca = "${visit ? loca : ' '}";
  mapOption = { center: new kakao.maps.LatLng(33.450701, 126.570667), level: 3 }; geocoder.addressSearch(loca, function(){}); }</script></body></html>`;
}

test('streetAddress: sido + sigungu + road/lot number, floor/unit kept, anything after dropped', () => {
  const cases = {
    '서울 송파구 올림픽로10길 13 1층': '서울 송파구 올림픽로10길 13 1층',
    '충북 청주시 흥덕구 증안로22번길 33 1층 일부호': '충북 청주시 흥덕구 증안로22번길 33 1층 일부호',
    '대구 동구 신천동 338-1': '대구 동구 신천동 338-1',
    '경남 양산시 삼호동 1011 2층 초량 갈비쌈냉면 양산웅상점': '경남 양산시 삼호동 1011 2층',
    '서울 성동구 응봉동 98 응봉동': '서울 성동구 응봉동 98',
    '서울특별시 강남구 테헤란로 37길 7': '서울특별시 강남구 테헤란로 37길 7',
    '세종특별자치시 한누리대로 2130, 2층': '세종특별자치시 한누리대로 2130 2층',
    '경기 남양주시 와부읍 덕소리 산 12': '경기 남양주시 와부읍 덕소리 산 12'
  };
  for (const [input, address] of Object.entries(cases)) assert.equal(streetAddress(input)?.address, address, input);
  assert.equal(streetAddress('경남 양산시 삼호동 1011').sido, '경남');
  for (const bad of ['', '매장으로 문의해 주세요', '서울 송파구', '송파구 올림픽로10길 13', '서울 송파구 올림픽로10길', '전국 어디서나 1', 'Seoul 13'])
    assert.equal(streetAddress(bad), null, bad);
});

test('safeMapUrl: https map hosts only', () => {
  assert.equal(safeMapUrl('https://naver.me/5f5RkyZV'), 'https://naver.me/5f5RkyZV');
  assert.equal(safeMapUrl('https://place.map.kakao.com/123'), 'https://place.map.kakao.com/123');
  for (const bad of ['http://naver.me/x', 'javascript:alert(1)', 'https://naver.me.evil.example/x', 'https://user:pw@naver.me/x', 'https://naver.me:8443/x', '//naver.me/x', 'https://evil.example/?u=https://naver.me', ''])
    assert.equal(safeMapUrl(bad), null, bad);
});

test('parseDinnerqueenPlace: visible 방문 위치 only; footer, comments and other coordinates never count', () => {
  assert.deepEqual(parseDinnerqueenPlace(dqPage()), {
    status: 'found', address: '서울 송파구 올림픽로10길 13 1층', sido: '서울', lat: 37.510531, lng: 127.081285, mapUrl: 'https://naver.me/5f5RkyZV'
  });
  // the visible text wins over the (older) copy kept in the comment
  assert.equal(parseDinnerqueenPlace(dqPage({ old: '서울 강남구 역삼동 1' })).address, '서울 송파구 올림픽로10길 13 1층');
  // product campaign: only the platform footer has an address
  assert.deepEqual(parseDinnerqueenPlace(dqPage({ visit: false })), { status: 'none' });
  // the whole section commented out (closed or not): nothing is on the page
  const whole = dqPage().replace('<section>', '<!-- <section>').replace('<script>// 네이버', '--> <script>// 네이버');
  assert.deepEqual(parseDinnerqueenPlace(whole), { status: 'none' });
  assert.deepEqual(parseDinnerqueenPlace(dqPage().replace('<section>', '<!-- <section>')), { status: 'none' });
  // two copies that disagree, a non-address, an empty page
  assert.deepEqual(parseDinnerqueenPlace(dqPage() + dqPage({ address: '서울 강남구 역삼동 1' })), { status: 'mismatch' });
  assert.deepEqual(parseDinnerqueenPlace(dqPage({ address: '매장 위치는 선정 후 안내' })), { status: 'unparsed' });
  assert.deepEqual(parseDinnerqueenPlace(''), { status: 'unparsed' });
  // markup in the section is text, never HTML; the address stops at the lot number
  const xss = parseDinnerqueenPlace(dqPage({ address: '서울 송파구 올림픽로10길 13 <img src=x onerror=alert(1)>"><script>alert(1)</script>' }));
  assert.equal(xss.address, '서울 송파구 올림픽로10길 13');
  // unsafe link and impossible / placeholder coordinates are dropped, the address stays
  const odd = parseDinnerqueenPlace(dqPage({ link: 'javascript:alert(1)', lat: '0.1', lng: '127.1' }));
  assert.deepEqual([odd.address, odd.lat, odd.mapUrl], ['서울 송파구 올림픽로10길 13 1층', undefined, undefined]);
  assert.equal(parseDinnerqueenPlace(dqPage({ lat: '33.450701', lng: '126.570667' })).lat, undefined);
});

test('parseGangnamPlace: 방문 및 예약 section, store name trimmed, loca must agree, placeholder centre ignored', () => {
  assert.deepEqual(parseGangnamPlace(gnPage()), { status: 'found', address: '경남 양산시 삼호동 1011 2층', sido: '경남', mapUrl: 'https://naver.me/5YwTCBh2' });
  assert.equal(parseGangnamPlace(gnPage({ text: '서울 성동구 응봉동 98 응봉동' })).address, '서울 성동구 응봉동 98');
  assert.deepEqual(parseGangnamPlace(gnPage({ visit: false })), { status: 'none' }, 'delivery: no visit section');
  assert.deepEqual(parseGangnamPlace(gnPage({ loca: '서울 강남구 역삼동 1' })), { status: 'mismatch' });
  const hidden = gnPage().replace('<li><dl><dt>방문 및 예약', '<!-- <li><dl><dt>방문 및 예약').replace('</ul>', '--></ul>');
  assert.deepEqual(parseGangnamPlace(hidden), { status: 'none' }, 'commented-out section');
  assert.equal(parseGangnamPlace(gnPage({ link: 'http://naver.me/x' })).mapUrl, undefined);
  assert.equal(parseGangnamPlace(gnPage()).lat, undefined, 'no coordinates are invented');
});

test('placeFields: visit campaigns only, same province, never manual', () => {
  const entry = { url: 'https://gangnam-review.net/cp/?id=1', checkedAt: '2026-11-13T03:00:00.000Z', place: { status: 'found', address: '경남 양산시 삼호동 1011 2층', sido: '경남', mapUrl: 'https://naver.me/x' } };
  assert.deepEqual(placeFields(entry, { type: '방문형', region_sido: '경남' }), {
    address: '경남 양산시 삼호동 1011 2층', addressOrigin: 'campaign', addressSourceUrl: 'https://gangnam-review.net/cp/?id=1', addressCheckedAt: '2026-11-13T03:00:00.000Z', mapUrl: 'https://naver.me/x'
  });
  assert.ok(placeFields(entry, {}), 'legacy snapshot without a type');
  for (const record of [{ type: '배송형' }, { type: '기자단' }, { type: '구매평' }, { type: '방문형', manual: true }, { type: '방문형', region_sido: '서울' }])
    assert.equal(placeFields(entry, record), null, JSON.stringify(record));
  assert.equal(placeFields({ ...entry, place: { status: 'none' } }, { type: '방문형' }), null);
});

// fake origins for both hosts; every request recorded
function origins(pages, robots = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(u.host + u.pathname + u.search);
    assert.equal(init.redirect, 'manual');
    if (u.pathname === '/robots.txt') return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => robots[u.host] ?? 'User-agent: *\nAllow: /' };
    const key = u.host === 'dinnerqueen.net' ? 'dq' + u.pathname.split('/').pop() : 'gn' + u.searchParams.get('id');
    return { status: 200, headers: new Headers({ 'content-type': 'text/html; charset=UTF-8' }), text: async () => pages[key] ?? '' };
  };
  return { calls, fetchImpl, pageCalls: () => calls.filter(c => !c.endsWith('/robots.txt')) };
}
const GN_ROBOTS = 'User-agent: *\r\nAllow: / \r\nDisallow: /adm\r\nDisallow: /review\r\nDisallow: /cp/?id=1512660\r\n';
const dq = (n, extra = {}) => ({ id: `dinnerqueen:${n}`, source: 'dinnerqueen', precision: 'days_left', type: '방문형', ...extra });
const gn = (n, extra = {}) => ({ id: `gangnammat:${n}`, source: 'gangnammat', precision: 'days_left', type: '방문형', ...extra });

test('verifier: one page request gives deadline and address; gangnam visit only, robots on path+query; old entries filled once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-13T03:00:00Z');
  const file = path.join(dir, 'd.json');
  // an entry written before addresses existed: verified deadline, no `place`
  fs.writeFileSync(file, JSON.stringify({ 'dinnerqueen:3': { status: 'verified', deadline: '2026-11-16', start: '2026-11-10', evidence: 'x', checkedAt: 'old', url: 'https://dinnerqueen.net/taste/3', expires: clock + 3600e3 } }));
  const pages = { dq4: dqPage(), dq1: dqPage(), dq2: dqPage({ visit: false }), dq3: dqPage({ address: '대구 동구 신천동 338-1' }), gn5: gnPage(), gn1512660: gnPage() };
  const o2 = origins(pages, { 'gangnam-review.net': GN_ROBOTS });
  const v = createDeadlineVerifier({ filePath: file, fetch: o2.fetchImpl, now: () => clock, intervalMs: 1000, sleep: async ms => { clock += ms; }, monotonic: () => clock });

  assert.equal(v.supports(gn(5, { type: '배송형' })), false, 'gangnam delivery is never fetched');
  assert.equal(v.supports({ id: 'reviewnote:1', source: 'reviewnote', type: '방문형' }), false);
  const r = await v.verifySome([dq(1), gn(5), gn(1512660), gn(6, { type: '배송형' }), { id: 'reviewnote:1', source: 'reviewnote' }, dq(2), dq(3)], { max: 3, budgetMs: 60000 });
  assert.deepEqual(r, { candidates: 3, verified: 1, addresses: 2, checked: 2, deferred: 'robots_disallow' });
  assert.deepEqual(o2.pageCalls(), ['dinnerqueen.net/taste/1', 'gangnam-review.net/cp/?id=5'], 'disallowed id and delivery/reviewnote never requested');
  const map = await v.verifiedMap();
  const one = v.apply(dq(1, { region_sido: '서울' }), map);
  assert.deepEqual([one.precision, one.deadline, one.address, one.addressOrigin, one.mapUrl, one.addressSourceUrl],
    ['exact_date', '2026-11-16', '서울 송파구 올림픽로10길 13 1층', 'campaign', 'https://naver.me/5f5RkyZV', 'https://dinnerqueen.net/taste/1']);
  assert.equal(v.apply(gn(5), map).address, '경남 양산시 삼호동 1011 2층');
  assert.equal(v.apply(gn(5), map).precision, 'days_left', 'gangnam dates are not touched');
  assert.equal(v.apply(gn(5, { type: '배송형' }), map).address, undefined, 'type now delivery: no address');

  // next run: the product page (no visit section) and the old entry (one extra request to fill its address)
  const before = o2.pageCalls().length;
  const r2 = await v.verifySome([dq(1), gn(5), dq(2), dq(3)], { max: 3, budgetMs: 60000 });
  assert.deepEqual(o2.pageCalls().slice(before), ['dinnerqueen.net/taste/2', 'dinnerqueen.net/taste/3']);
  assert.equal(r2.addresses, 1);
  const m2 = await v.verifiedMap();
  assert.equal(v.apply(dq(2), m2).address, undefined, 'product campaign has no address');
  assert.equal(v.apply(dq(3), m2).address, '대구 동구 신천동 338-1');
  // a visit campaign whose source date is already exact: fetched for its address, the source date is kept
  const r3 = await v.verifySome([dq(4, { precision: 'exact', deadline: '2026-11-30' })], { max: 3, budgetMs: 60000 });
  assert.equal(r3.addresses, 1);
  const exact = v.apply(dq(4, { precision: 'exact', deadline: '2026-11-30' }), await v.verifiedMap());
  assert.deepEqual([exact.address, exact.precision, exact.deadline], ['서울 송파구 올림픽로10길 13 1층', 'exact', '2026-11-30']);
  assert.equal(v.supports(dq(4, { precision: 'exact', type: '배송형' })), false, 'exact-date delivery: nothing to check');
  // everything known now: no more requests
  const after = o2.calls.length;
  await v.verifySome([dq(1), gn(5), dq(2), dq(3), dq(4, { precision: 'exact' })], { max: 3, budgetMs: 60000 });
  assert.equal(o2.calls.length, after);
  await v.flush();
  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes('<') && !stored.includes('detailPlaceLink'), 'no HTML is stored');
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
  return (route, init) => fetch(base + route, init).then(r => r.status === 204 ? null : r.json());
}
function memoryStore() {
  const rows = new Map();
  const k = (s, o, key) => JSON.stringify([s, o, key]);
  return {
    rows,
    get: async (s, o, key) => rows.get(k(s, o, key)) || null,
    set: async (s, o, key, v) => { rows.set(k(s, o, key), v); },
    remove: async (s, o, key) => { rows.delete(k(s, o, key)); },
    list: async (s, o) => Object.fromEntries([...rows].filter(([x]) => { const p = JSON.parse(x); return p[0] === s && p[1] === o; }).map(([x, v]) => [JSON.parse(x)[2], v])),
    acquire: async () => true, release: async () => {}, prune: async () => {}
  };
}

test('API: original address first, else Kakao hit (labelled), never for delivery/manual; list, favorites and marks agree', async t => {
  const NOW = Date.parse('2026-11-13T03:00:00Z');
  const seen = new Date(NOW - 3600e3).toISOString();
  const SOURCE = [
    { id: 'gangnammat:5', source_id: 'gangnammat', title: '[경남 양산] 초량 갈비쌈냉면 양산웅상점', campaign_type: '방문형', region_sido: '경남', region_text: '경남 양산', original_url: 'https://gangnam-review.net/cp/?id=5', apply_deadline: '2026-11-20', last_seen_at: seen },
    { id: 'reviewnote:7', source_id: 'reviewnote', title: '[서울/송파] 카카오매장', campaign_type: '방문형', region_sido: '서울', region_text: '서울/송파구', original_url: 'https://www.reviewnote.co.kr/campaigns/7', apply_deadline: '2026-11-21', last_seen_at: seen },
    { id: 'reviewnote:8', source_id: 'reviewnote', title: '[서울/송파] 배송상품', campaign_type: '배송형', region_sido: '서울', region_text: '서울/송파구', original_url: 'https://www.reviewnote.co.kr/campaigns/8', apply_deadline: '2026-11-22', last_seen_at: seen },
    { id: 'gangnammat:9', source_id: 'gangnammat', title: '배송으로 바뀐 공고', campaign_type: '배송형', region_sido: '경남', original_url: 'https://gangnam-review.net/cp/?id=9', apply_deadline: '2026-11-23', last_seen_at: seen }
  ];
  const o = origins({ gn5: gnPage(), gn9: gnPage() }, { 'gangnam-review.net': GN_ROBOTS });
  const fetchImpl = async (url, init) => String(url).includes('campaigns.json') ? { ok: true, status: 200, json: async () => SOURCE } : o.fetchImpl(url, init);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addr-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = memoryStore();
  await store.set('session', '', 'fixture', { user: { id: 'kakao:1', nickname: 'tester' }, expires: NOW + 3600e3 });
  const deadlines = createDeadlineVerifier({ store: null, filePath: path.join(dir, 'd.json'), fetch: o.fetchImpl, now: () => NOW, intervalMs: 0 });
  // an old check of 9 from when it was a visit campaign: its stored address must not reach the delivery campaign
  await deadlines.verifyOne({ id: 'gangnammat:9', source: 'gangnammat', type: '방문형' });
  const before = o.pageCalls().length;
  // a fake Kakao hit for every record: only the visit campaign without an original address may use it
  const hit = { s: 'hit', lat: 37.5, lng: 127.1, name: '카카오매장', url: 'https://place.map.kakao.com/42', address: '서울 송파구 백제고분로 1', t: NOW - 60e3 };
  const places = { keyFor: () => 'k', get: () => hit, prepare: async () => {}, enqueue() {}, stats: () => ({ state: 'ok', located: 1, pending: 0 }), anchor: async () => null };
  // serverless without waitUntil: the check runs inline and the same answer already shows the found address
  const call = await listServer(t, { store, env: { KAKAO_LOCAL: '0', VERCEL: '1' }, fetch: fetchImpl, now: () => NOW, deadlines, places });
  const list = await call('/api/campaigns');
  assert.equal(list.deadlineCheck.addresses, 1, 'gangnam address found inline (no deadline verified)');
  const by = id => list.records.find(r => r.id === id);
  assert.deepEqual([by('gangnammat:5').address, by('gangnammat:5').addressOrigin, by('gangnammat:5').mapUrl], ['경남 양산시 삼호동 1011 2층', 'campaign', 'https://naver.me/5YwTCBh2']);
  assert.deepEqual([by('reviewnote:7').address, by('reviewnote:7').addressOrigin, by('reviewnote:7').mapUrl], ['서울 송파구 백제고분로 1', 'kakao', 'https://place.map.kakao.com/42']);
  assert.equal(by('reviewnote:8').address, undefined, 'delivery: no Kakao address');
  assert.equal(by('gangnammat:9').address, undefined, 'delivery now: old visit address not shown');
  assert.deepEqual(o.pageCalls().slice(before), ['gangnam-review.net/cp/?id=5'], 'only the visit campaign was fetched, once');
  assert.ok(!o.calls.some(c => c.includes('reviewnote')), 'reviewnote is never fetched');

  const headers = { cookie: 'sid=fixture', 'Content-Type': 'application/json' };
  const fields = r => [r.address, r.addressOrigin, r.mapUrl, r.addressSourceUrl];
  for (const id of ['gangnammat:5', 'reviewnote:7', 'reviewnote:8']) await call(`/api/favorites/${encodeURIComponent(id)}`, { method: 'PUT', headers });
  // legacy favorite saved without type/address for the campaign that is delivery now
  await store.set('favorite', 'kakao:1', 'gangnammat:9', { id: 'gangnammat:9', title: 'x', source: 'gangnammat', region_sido: '경남', channels: [], savedAt: new Date(NOW).toISOString() });
  await store.set('favorite', 'kakao:1', 'manual:1', { id: 'manual:1', manual: true, title: '직접', source: 'other', type: '방문형', address: '서울 송파구 올림픽로 1', addressOrigin: 'campaign', channels: [], savedAt: new Date(NOW).toISOString() });
  const favs = (await call('/api/favorites', { headers })).items;
  const fav = id => favs.find(r => r.id === id);
  assert.deepEqual(fields(fav('gangnammat:5')), fields(by('gangnammat:5')));
  assert.deepEqual(fields(fav('reviewnote:7')), fields(by('reviewnote:7')));
  assert.equal(fav('reviewnote:8').address, undefined, 'delivery favorite: no address');
  assert.equal(fav('gangnammat:9').address, undefined, 'legacy snapshot + current delivery type: no address');
  assert.equal(fav('manual:1').address, undefined, 'hand-added: never an address');
  await call('/api/marks/gangnammat%3A5', { method: 'PUT', headers, body: JSON.stringify({ status: 'excluded' }) });
  const excluded = (await call('/api/marks?status=excluded', { headers })).items;
  assert.deepEqual(fields(excluded[0]), fields(by('gangnammat:5')));
  assert.equal(o.pageCalls().length - before, 1, 'favorites and marks reuse the stored check');
});

test('parsers ignore look-alike sections inside script/style/template/noscript text', () => {
  const inScript = `<!doctype html><body>${FOOTER}<script>var tpl = '<p><span>방문 위치</span>: 서울 송파구 올림픽로10길 13 1층 </p>';</script></body>`;
  assert.deepEqual(parseDinnerqueenPlace(inScript), { status: 'none' });
  for (const tag of ['template', 'noscript', 'style', 'textarea']) {
    const dq = `<body><${tag}><p><span>방문 위치</span>: 서울 송파구 올림픽로10길 13 1층 </p></${tag}>${FOOTER}</body>`;
    assert.deepEqual(parseDinnerqueenPlace(dq), { status: 'none' }, tag);
    const gnHidden = gnPage().replace('<ul class="detail_info">', `<${tag}><ul class="detail_info">`).replace('</ul>', `</ul></${tag}>`);
    assert.deepEqual(parseGangnamPlace(gnHidden), { status: 'none' }, 'gangnam ' + tag);
  }
  // the marker is read from real scripts only: a LatLng written in visible text is not a coordinate
  const textMarker = dqPage().replace(/<script>\/\/ 네이버 지도[\s\S]*?<\/script>/, '<p>new naver.maps.LatLng(37.1, 127.1)</p>');
  assert.equal(parseDinnerqueenPlace(textMarker).lat, undefined);
});

test('verifier: a failed address fill-in keeps the older verified deadline and its expiry; cold instances skip fresh negatives', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addr-keep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = Date.parse('2026-11-13T03:00:00Z');
  const file = path.join(dir, 'd.json');
  const legacy = { status: 'verified', deadline: '2026-11-16', start: '2026-11-10', evidence: '신청 기간 26.11.10 – 26.11.16', checkedAt: 'old', url: 'https://dinnerqueen.net/taste/3', expires: clock + 2 * 3600e3 };
  const negative = n => ({ status: 'checked', place: { status: 'none' }, checkedAt: 'old', url: `https://gangnam-review.net/cp/?id=${n}`, expires: clock + 3600e3 });
  fs.writeFileSync(file, JSON.stringify({ 'dinnerqueen:3': legacy, 'gangnammat:1': negative(1), 'gangnammat:2': negative(2), 'gangnammat:3': negative(3) }));
  const calls = [];
  const fetchImpl = async url => {
    const u = new URL(url); calls.push(u.host + u.pathname + u.search);
    if (u.pathname === '/robots.txt') return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => 'User-agent: *\nAllow: /' };
    if (u.host === 'dinnerqueen.net') return { status: 503, headers: new Headers(), text: async () => '' };
    return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => gnPage() };
  };
  const make = () => createDeadlineVerifier({ filePath: file, fetch: fetchImpl, now: () => clock, intervalMs: 0 });
  const v = make();
  const e = await v.verifyOne(dq(3));
  assert.deepEqual([e.status, e.deadline, e.expires, e.place.status], ['verified', '2026-11-16', legacy.expires, 'error'], 'deadline and expiry kept, address failure recorded');
  const applied = v.apply(dq(3), await v.verifiedMap());
  assert.deepEqual([applied.precision, applied.deadline, applied.address], ['exact_date', '2026-11-16', undefined]);
  const n = calls.length;
  await v.verifyOne(dq(3));
  assert.equal(calls.length, n, 'not retried before the kept expiry');

  // a new (cold) instance: three fresh negatives must not take the three picks
  const cold = make();
  const r = await cold.verifySome([gn(1), gn(2), gn(3), gn(4)], { max: 3, budgetMs: 60000 });
  assert.deepEqual([r.candidates, r.addresses], [1, 1]);
  assert.deepEqual(calls.filter(c => c.includes('/cp/')), ['gangnam-review.net/cp/?id=4']);
});

test('verifier: address enrichment with an unreadable period preserves an unexpired verified deadline', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addr-period-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = Date.parse('2026-11-13T03:00:00Z');
  for (const [kind, page] of [['unparsed', dqPage({ period: false })], ['mismatch', dqPage().replace("end: '2026-11-17'", "end: '2026-11-18'")]]) {
    const file = path.join(dir, `${kind}.json`);
    const legacy = { status: 'verified', deadline: '2026-11-16', start: '2026-11-10', evidence: 'previous period', checkedAt: 'old', url: 'https://dinnerqueen.net/taste/3', expires: clock + 3600e3 };
    fs.writeFileSync(file, JSON.stringify({ 'dinnerqueen:3': legacy }));
    const v = createDeadlineVerifier({ filePath: file, now: () => clock, intervalMs: 0, fetch: async url => ({
      status: 200, headers: new Headers({ 'content-type': String(url).endsWith('/robots.txt') ? 'text/plain' : 'text/html' }),
      text: async () => String(url).endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : page
    }) });
    const entry = await v.verifyOne(dq(3));
    assert.deepEqual([entry.status, entry.deadline, entry.expires], ['verified', legacy.deadline, legacy.expires], kind);
    assert.equal(entry.place.status, 'found', 'address enrichment still succeeds independently');
    await v.flush();
  }
});

test('API cold start: favorites/marks read the shared list for current types and stored Kakao hits without new requests', async t => {
  const NOW = Date.parse('2026-11-13T03:00:00Z');
  const seen = new Date(NOW - 3600e3).toISOString();
  const SOURCE = [
    { id: 'reviewnote:7', source_id: 'reviewnote', title: '[서울/송파] 카카오매장', campaign_type: '방문형', region_sido: '서울', region_text: '서울/송파구', original_url: 'https://www.reviewnote.co.kr/campaigns/7', apply_deadline: '2026-11-21', last_seen_at: seen },
    { id: 'gangnammat:9', source_id: 'gangnammat', title: '배송으로 바뀐 공고', campaign_type: '배송형', region_sido: '경남', original_url: 'https://gangnam-review.net/cp/?id=9', apply_deadline: '2026-11-23', last_seen_at: seen },
    { id: 'gangnammat:10', source_id: 'gangnammat', title: '유형 미확인 공고', campaign_type: null, region_sido: '경남', original_url: 'https://gangnam-review.net/cp/?id=10', apply_deadline: '2026-11-23', last_seen_at: seen }
  ];
  let sourceCalls = 0, kakaoLoads = 0;
  const fetchImpl = async url => { assert.ok(String(url).includes('campaigns.json'), 'no original page or Kakao request'); sourceCalls++; return { ok: true, status: 200, json: async () => SOURCE }; };
  const store = memoryStore();
  await store.set('session', '', 'fixture', { user: { id: 'kakao:1', nickname: 'tester' }, expires: NOW + 3600e3 });
  // a stored address check of 9 from when it was a visit campaign
  const entry9 = { status: 'checked', place: { status: 'found', address: '경남 양산시 삼호동 1011 2층', sido: '경남' }, checkedAt: 'old', url: 'https://gangnam-review.net/cp/?id=9', expires: NOW + 3600e3 };
  const real = createDeadlineVerifier({ filePath: path.join(os.tmpdir(), `unused-${process.pid}.json`), fetch: async () => { throw new Error('no request expected'); } });
  const deadlines = { supports: () => false, verifySome: async () => ({}), flush: async () => {}, verifiedMap: async () => new Map([['gangnammat:9', entry9]]), apply: real.apply };
  const hit = { s: 'hit', lat: 37.5, lng: 127.1, name: '카카오매장', url: 'https://place.map.kakao.com/42', address: '서울 송파구 백제고분로 1', t: NOW };
  const makePlaces = () => {
    let loaded = false;
    return { keyFor: r => (r.id === 'reviewnote:7' ? 'k7' : null), loadCached: async () => { kakaoLoads++; loaded = true; return {}; }, get: k => (loaded && k === 'k7' ? hit : null),
      prepare: async () => {}, enqueue() {}, stats: () => ({ state: 'ok', located: 1, pending: 0 }), anchor: async () => null };
  };
  // warm instance writes the shared list row
  const warm = await listServer(t, { store, env: { KAKAO_LOCAL: '0' }, fetch: fetchImpl, now: () => NOW, deadlines, places: makePlaces(), waitUntil: () => {} });
  const list = await warm('/api/campaigns');
  assert.equal(list.records.find(r => r.id === 'reviewnote:7').address, '서울 송파구 백제고분로 1', 'no radius: stored Kakao hit still read');
  // snapshots saved while 9 was a visit campaign
  const old = { title: 'x', source: 'gangnammat', type: '방문형', region_sido: '경남', channels: [], address: '경남 양산시 삼호동 1011 2층', addressOrigin: 'campaign', savedAt: new Date(NOW).toISOString() };
  await store.set('favorite', 'kakao:1', 'gangnammat:9', { ...old, id: 'gangnammat:9' });
  await store.set('favorite', 'kakao:1', 'reviewnote:7', { id: 'reviewnote:7', title: 'y', source: 'reviewnote', region_sido: '서울', channels: [], savedAt: new Date(NOW).toISOString() });
  await store.set('favorite', 'kakao:1', 'gangnammat:404', { ...old, id: 'gangnammat:404' });
  await store.set('favorite', 'kakao:1', 'gangnammat:10', { ...old, id: 'gangnammat:10' });
  const calls = sourceCalls;
  // cold instance: its first request is a favorites read
  const cold = await listServer(t, { store, env: { KAKAO_LOCAL: '0' }, fetch: fetchImpl, now: () => NOW, deadlines, places: makePlaces(), waitUntil: () => {} });
  const headers = { cookie: 'sid=fixture' };
  const favs = (await cold('/api/favorites', { headers })).items;
  const fav = id => favs.find(r => r.id === id);
  assert.equal(fav('gangnammat:9').address, undefined, 'old visit snapshot, now delivery: hidden');
  assert.equal(fav('reviewnote:7').address, '서울 송파구 백제고분로 1', 'stored Kakao hit read on a cold instance');
  assert.equal(fav('reviewnote:7').addressOrigin, 'kakao');
  assert.equal(fav('gangnammat:404').address, undefined, 'not in the current list: type unknown, hidden');
  assert.equal(fav('gangnammat:10').address, undefined, 'current type unknown: old visit address hidden');
  await store.set('mark', 'kakao:1', 'gangnammat:9', { ...old, status: 'excluded', at: new Date(NOW).toISOString() });
  const marks = (await cold('/api/marks?status=excluded', { headers })).items;
  assert.equal(marks[0].address, undefined);
  assert.equal(sourceCalls, calls, 'the cold reads used the shared row, not the source');
  assert.ok(kakaoLoads >= 2);
});
