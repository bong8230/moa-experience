'use strict';
// Run: node --test kakao-local.test.js   (no network: Kakao Local is mocked)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlaceLocator, extractName, choose } = require('./kakao-local.js');

const KEY = 'secret-rest-key-xyz';
const doc = (place_name, address_name, y, x, id = '1') => ({ place_name, address_name, y: String(y), x: String(x), place_url: `http://place.map.kakao.com/${id}` });
const YEONGTONG = { lat: 37.2596, lng: 127.0466, level: 'sgg', label: '경기 수원시 영통구' };

test('extractName strips region brackets and offer words', () => {
  assert.equal(extractName('[서울/강남]포트캔커피 강남대치점'), '포트캔커피 강남대치점');
  assert.equal(extractName('[인천/연수구] 준오헤어 에스파이브시티점 커트 : 무료'), '준오헤어 에스파이브시티점 커트');
  assert.equal(extractName('[ 충남 ] 천안 / 하노이맥주밤거리 천안두정점'), '하노이맥주밤거리 천안두정점');
  assert.equal(extractName('[서울 용산] 연예인 방문 샵 경력자로 구성된 [파인더트리에스테틱]'), '파인더트리에스테틱');
  assert.equal(extractName('[경기 시흥시] [시흥 배곧] 족발신선생 배곧점 🍖 4만원 식사권 제공'), '족발신선생 배곧점');
  assert.equal(extractName('[세종] 큰집뼈대있는짬뽕_피드or릴스'), '큰집뼈대있는짬뽕');
  assert.equal(extractName('[스트레칭조이 을지로본점] 체형관리, 스트레칭 프로그램 이용권', 'realreview'), '스트레칭조이 을지로본점');
  assert.equal(extractName('[대구 달성군] 1대1 프리미엄 소개팅'), null);
  assert.equal(extractName(''), null);
});

test('choose keeps only same-province, nearby, name-matching places', () => {
  const job = { name: '트두헤어', sido: '경기', centre: YEONGTONG, maxKm: 20 };
  const hit = choose([doc('트두헤어 영통점', '경기 수원시 영통구 매탄동 1', 37.262, 127.05, '77')], job);
  assert.deepEqual(hit, { status: 'hit', lat: 37.262, lng: 127.05, name: '트두헤어 영통점', url: 'https://place.map.kakao.com/77', address:'경기 수원시 영통구 매탄동 1', roadAddress:null, jibunAddress:'경기 수원시 영통구 매탄동 1' });
  assert.equal(choose([doc('트두헤어', '서울 강남구 역삼동 1', 37.5, 127.03)], job).status, 'miss', 'other province');
  assert.equal(choose([doc('트두헤어', '경기 파주시 1', 37.76, 126.78)], job).status, 'miss', 'outside radius');
  assert.equal(choose([doc('다른가게', '경기 수원시 영통구 1', 37.26, 127.05)], job).status, 'miss', 'name mismatch');
  assert.equal(choose([doc('트두헤어 영통점', '경기도 수원시 영통구 1', 37.26, 127.05)], job).status, 'hit', 'long province name');
});

test('choose preserves cleaned road and lot addresses while keeping matching and map URL checks', () => {
  const job = { name:'트두헤어', sido:'경기', centre:YEONGTONG, maxKm:20 };
  const hit = choose([{ ...doc('트두헤어', '경기 수원시  매탄동 1', 37.262, 127.05), road_address_name:' 경기 수원시\n 영통로\u0000 12 ' }], job);
  assert.equal(hit.address,'경기 수원시 영통로 12');
  assert.equal(hit.roadAddress,hit.address);
  assert.equal(hit.jibunAddress,'경기 수원시 매탄동 1');
  const long = choose([{...doc('트두헤어','경기 수원시 1',37.262,127.05),road_address_name:'가'.repeat(250)}],job);
  assert.equal([...long.address].length,200);
  assert.equal(choose([{...doc('트두헤어','서울 강남구 1',37.262,127.05),road_address_name:'경기 수원시 1'}],job).status,'miss','address preservation does not relax province matching');
});

test('choose rejects same-name branches far apart, accepts near duplicates', () => {
  const job = { name: '쌈지냉면', sido: '서울', centre: { lat: 37.55, lng: 126.85 }, maxKm: 20 };
  const far = choose([doc('쌈지냉면 화곡점', '서울 강서구 화곡동', 37.54, 126.84), doc('쌈지냉면 마곡점', '서울 강서구 마곡동', 37.57, 126.83)], job);
  assert.equal(far.status, 'ambiguous');
  const exact = choose([doc('쌈지냉면', '서울 강서구 화곡동', 37.54, 126.84, '5'), doc('쌈지냉면 마곡점', '서울 강서구 마곡동', 37.57, 126.83)], job);
  assert.equal(exact.status, 'hit', 'one exact name wins');
  assert.equal(exact.url, 'https://place.map.kakao.com/5');
  const bad = choose([{ ...doc('쌈지냉면', '서울 강서구', 37.54, 126.84), place_url: 'javascript:alert(1)' }], job);
  assert.equal(bad.url, null, 'only kakao place links pass');
});

function harness(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const logs = [];
  const log = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return handler(new URL(url)); };
  const cachePath = path.join(dir, 'kakao-places.json');
  const locator = createPlaceLocator({ key: KEY, fetch: fetchImpl, cachePath, intervalMs: 0, log });
  const idle = async () => { for (let i = 0; i < 200 && !locator.idle(); i++) await new Promise(r => setTimeout(r, 5)); };
  return { locator, calls, logs, cachePath, idle };
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const record = (title, extra = {}) => ({ type: '방문형', title, region_sido: '경기', source: 'reviewnote', ...extra });

test('locator searches around the region centre, retries a shorter name, keeps the key out of URL/cache', async t => {
  const h = harness(t, url => {
    const q = url.searchParams.get('query');
    if (q === '오르헤어영통점 레이어드컷') return reply(200, { documents: [] });
    if (q === '오르헤어영통점') return reply(200, { documents: [doc('오르헤어 영통점', '경기 수원시 영통구', 37.251, 127.071, '9')] });
    return reply(200, { documents: [] });
  });
  const r = record('[경기/수원시] 오르헤어영통점 레이어드컷/펌 5,000 P');
  const k = h.locator.keyFor(r, YEONGTONG);
  h.locator.enqueue([{ key: k, record: r, centroid: YEONGTONG }]);
  await h.idle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].init.headers.Authorization, `KakaoAK ${KEY}`);
  assert.equal(h.calls[0].url.searchParams.get('x'), '127.0466');
  assert.equal(h.calls[0].url.searchParams.get('radius'), '20000');
  for (const c of h.calls) assert.ok(!c.url.href.includes(KEY), 'key not in URL');
  const got = h.locator.get(k);
  assert.equal(got.name, '오르헤어 영통점');
  assert.equal(h.locator.stats().located, 1);
  // cached: no second lookup
  h.locator.enqueue([{ key: k, record: r, centroid: YEONGTONG }]);
  await h.idle();
  assert.equal(h.calls.length, 2);
  await new Promise(r => setTimeout(r, 3200)); // debounced save
  const saved = fs.readFileSync(h.cachePath, 'utf8');
  assert.ok(saved.includes('오르헤어 영통점'));
  assert.ok(!saved.includes(KEY));
});

test('non-visit records and nameless titles are never sent', () => {
  const h = { locator: createPlaceLocator({ key: KEY, fetch: async () => { throw new Error('no'); } }) };
  assert.equal(h.locator.keyFor(record('[경기] 세럼', { type: '배송형' }), YEONGTONG), null);
  assert.equal(h.locator.keyFor(record('[대구 달성군] 1대1 프리미엄 소개팅'), YEONGTONG), null);
  assert.equal(h.locator.keyFor(record('[경기] 트두헤어'), null), null);
});

test('403 (map service off) pauses lookups, keeps the job, logs without the key', async t => {
  const h = harness(t, () => reply(403, { errorType: 'NotAuthorizedError', message: 'disabled OPEN_MAP_AND_LOCAL service.' }));
  const r = record('[경기 수원] 트두헤어');
  const k = h.locator.keyFor(r, YEONGTONG);
  h.locator.enqueue([{ key: k, record: r, centroid: YEONGTONG }]);
  await h.idle().catch(() => {});
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.locator.stats(), { state: 'disabled', located: 0, pending: 1 });
  assert.equal(h.locator.get(k), null);
  assert.ok(h.logs.some(l => l.includes('HTTP 403')));
  assert.ok(h.logs.every(l => !l.includes(KEY)));
  assert.equal(await h.locator.anchor('강남역'), null, 'no calls while paused');
  assert.equal(h.calls.length, 1);
});

test('anchor resolves a typed landmark inside Korea only', async t => {
  const h = harness(t, url => url.searchParams.get('query') === '강남역'
    ? reply(200, { documents: [doc('강남역 2호선', '서울 강남구 역삼동', 37.4979, 127.0276)] })
    : reply(200, { documents: [doc('어딘가', 'x', 10, 10)] }));
  assert.deepEqual(await h.locator.anchor('강남역'), { lat: 37.4979, lng: 127.0276, level: 'place', label: '강남역 2호선' });
  assert.equal(await h.locator.anchor('해외'), null);
});
