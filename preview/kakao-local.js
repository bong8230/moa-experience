'use strict';
// Precise store coordinates via Kakao Local keyword search (server-side only).
// The REST key is sent only in the Authorization header to dapi.kakao.com; it is never logged,
// returned or written to disk. Only the store name (+ the centroid of the campaign's region as
// a search area) leaves this server. Anything unclear falls back to the region centroid.
const fs = require('node:fs');
const path = require('node:path');
const { distanceKm } = require('./geo.js');

const ENDPOINT = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const HIT_TTL = 30 * 864e5;
const MISS_TTL = 7 * 864e5;
const ERROR_TTL = 864e5;
const SIDO_LONG = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '광주', 대전광역시: '대전',
  울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북',
  충청남도: '충남', 전라북도: '전북', 전북특별자치도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남',
  제주특별자치도: '제주'
};
// words that describe the offer, not the store; the name ends before them
const STOP_WORD = /^(체험단?|체험권|촬영권|식사권|이용권|시술권|답례품|모집|무료|릴스|피드|쇼츠|클립|택\d|\d.*|.*\d+(원|만원|P|p|인|회|분|%)$)$/;
const PLACE_URL = /^https?:\/\/place\.map\.kakao\.com\/(\d+)$/;

const norm = s => String(s || '').toLowerCase().replace(/[\s.,·'"’()\-_&]+/g, '');
const cleanAddress = value => typeof value === 'string'
  ? [...value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 200).join('') || null
  : null;

// "[서울/강남] 포트캔커피 강남대치점 커트 : 무료" -> "포트캔커피 강남대치점"
function extractName(title, source) {
  let t = String(title || '').trim();
  // realreview puts the store (not the region) in the leading bracket: "[스트레칭조이 을지로본점] 체형관리"
  const lead = t.match(/^\[([^\]]{2,30})\]/);
  if (source === 'realreview' && lead) t = lead[1];
  t = t.replace(/^(\s*\[[^\]]*\]\s*)+/, '');
  // "[서울 용산] 설명 문구 [파인더트리에스테틱]": store name in a trailing bracket
  const tail = t.match(/\S.*\[([^\]]{2,30})\]\s*$/);
  if (tail) t = tail[1];
  t = t.replace(/^[^\s/[\]]{1,6}\s*\/\s*/, ''); // "전주 / 더 테라스"
  t = t.split(/\s[:：-]\s|[_(（[{|,!?/~]|\p{Extended_Pictographic}/u)[0];
  const words = [];
  for (const w of t.trim().split(/\s+/)) {
    if (!w || STOP_WORD.test(w)) break;
    words.push(w);
    if (words.length === 3) break;
  }
  const name = words.join(' ');
  return norm(name).length >= 2 ? name : null;
}

function sidoOf(address) {
  const first = String(address || '').split(' ')[0];
  return SIDO_LONG[first] || first || null;
}

// Pick one place from Kakao documents, or explain why not.
function choose(docs, { name, sido, centre, maxKm }) {
  const first = norm(name.split(' ')[0]);
  const full = norm(name);
  const ok = docs.map(d => ({ ...d, lat: Number(d.y), lng: Number(d.x) })).filter(d =>
    Number.isFinite(d.lat) && Number.isFinite(d.lng) &&
    (!sido || sidoOf(d.address_name || d.road_address_name) === sido) &&
    distanceKm(centre.lat, centre.lng, d.lat, d.lng) <= maxKm &&
    norm(d.place_name).includes(first));
  if (!ok.length) return { status: 'miss' };
  // prefer the exact name, then names containing the full query, then any match
  const equal = ok.filter(d => norm(d.place_name) === full);
  const contains = ok.filter(d => norm(d.place_name).includes(full));
  const pool = equal.length ? equal : contains.length ? contains : ok;
  const spread = Math.max(...pool.map(d => distanceKm(pool[0].lat, pool[0].lng, d.lat, d.lng)));
  if (pool.length > 1 && spread > 1) return { status: 'ambiguous' }; // same-name branches far apart
  const d = pool[0];
  const m = String(d.place_url || '').match(PLACE_URL);
  const roadAddress = cleanAddress(d.road_address_name), jibunAddress = cleanAddress(d.address_name);
  return {
    status: 'hit', lat: Math.round(d.lat * 1e6) / 1e6, lng: Math.round(d.lng * 1e6) / 1e6,
    name: String(d.place_name).slice(0, 60), url: m ? `https://place.map.kakao.com/${m[1]}` : null,
    address: roadAddress || jibunAddress, roadAddress, jibunAddress
  };
}

function createPlaceLocator({ key, fetch: fetchImpl = fetch, cachePath, now = Date.now, intervalMs = 150, dailyCap = 30000, log = console } = {}) {
  const entries = new Map();
  if (cachePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      for (const [k, v] of Object.entries(raw.entries || {})) entries.set(k, v);
    } catch { /* no cache yet */ }
  }
  const queue = new Map(); // key -> job
  let running = false, timer = null, saveTimer = null;
  let state = key ? 'ok' : 'off';
  let pausedUntil = 0, day = '', usedToday = 0;

  function fresh(e) {
    if (!e) return false;
    const ttl = e.s === 'hit' ? HIT_TTL : e.s === 'error' ? ERROR_TTL : MISS_TTL;
    return now() - e.t < ttl;
  }

  function keyFor(record, centroid) {
    if (record.type !== '방문형' || !centroid) return null;
    const name = extractName(record.title, record.source);
    return name ? `${record.region_sido || ''}|${centroid.label || ''}|${name}` : null;
  }

  function get(k) {
    const e = k && entries.get(k);
    return e && e.s === 'hit' ? e : null;
  }

  function save() {
    if (!cachePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const tmp = cachePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }));
        fs.renameSync(tmp, cachePath);
      } catch (err) { log.error('[places] cache save failed:', err.code || err.message); }
    }, 3000);
    saveTimer.unref?.();
  }

  async function search(params) {
    const url = new URL(ENDPOINT);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) { const err = new Error(`kakao local HTTP ${res.status}`); err.status = res.status; throw err; }
    const body = await res.json();
    return Array.isArray(body.documents) ? body.documents : [];
  }

  async function locate(job) {
    const words = job.name.split(' ');
    const area = { x: job.centre.lng, y: job.centre.lat, radius: Math.round(job.maxKm * 1000), size: 15 };
    let docs = await search({ query: job.name, ...area });
    if (!docs.length && words.length > 1) docs = await search({ query: words.slice(0, -1).join(' '), ...area });
    return choose(docs, job);
  }

  function schedule(ms) {
    if (timer || !queue.size) return;
    timer = setTimeout(() => { timer = null; pump(); }, ms);
    timer.unref?.();
  }

  async function pump() {
    if (running || state === 'off') return;
    if (now() < pausedUntil) return schedule(pausedUntil - now());
    running = true;
    try {
      while (queue.size) {
        const today = new Date(now() + 9 * 3600e3).toISOString().slice(0, 10);
        if (today !== day) { day = today; usedToday = 0; }
        if (usedToday >= dailyCap) { pausedUntil = now() + 3600e3; break; }
        const [k, job] = queue.entries().next().value;
        queue.delete(k);
        usedToday++;
        try {
          const { status, ...found } = await locate(job);
          entries.set(k, { s: status, ...found, t: now() });
          if (state !== 'ok') { state = 'ok'; log.log('[places] kakao local available again'); }
        } catch (err) {
          if (err.status === 401 || err.status === 403 || err.status === 429) {
            queue.set(k, job); // retry later
            pausedUntil = now() + (err.status === 429 ? 60e3 : 10 * 60e3);
            if (state !== 'disabled') log.error(`[places] kakao local unavailable (HTTP ${err.status}); using region centres, retrying every 10 min`);
            state = 'disabled';
            break;
          }
          entries.set(k, { s: 'error', t: now() });
        }
        save();
        await new Promise(r => { const t = setTimeout(r, intervalMs); t.unref?.(); });
      }
    } finally {
      running = false;
      schedule(Math.max(intervalMs, pausedUntil - now()));
    }
  }

  // queue every (store, region) not located yet; runs in the background
  function enqueue(items) {
    if (state === 'off') return;
    for (const { key: k, record, centroid } of items) {
      if (!k || queue.has(k) || fresh(entries.get(k))) continue;
      const maxKm = centroid.level === 'dong' ? 6 : 20;
      queue.set(k, { name: extractName(record.title, record.source), sido: record.region_sido || sidoOf(centroid.label), centre: centroid, maxKm });
    }
    pump();
  }

  // a typed anchor ("강남역") the region resolver did not know
  async function anchor(q) {
    if (state === 'off' || now() < pausedUntil) return null;
    try {
      const d = (await search({ query: q, size: 1 }))[0];
      if (!d) return null;
      const lat = Number(d.y), lng = Number(d.x);
      if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) return null;
      return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, level: 'place', label: String(d.place_name).slice(0, 40) };
    } catch (err) {
      if (err.status === 401 || err.status === 403) state = 'disabled';
      return null;
    }
  }

  function stats() {
    let located = 0;
    for (const e of entries.values()) if (e.s === 'hit') located++;
    return { state, located, pending: queue.size };
  }

  return { keyFor, get, enqueue, anchor, stats, idle: () => !running && !queue.size };
}

module.exports = { createPlaceLocator, extractName, choose };
