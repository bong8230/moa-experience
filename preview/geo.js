'use strict';
// Approximate campaign locations from free-form region text ("수원 영통", "광주/북구", "서울 성수")
// using administrative-area centroids (geo/kr-places.json, built from vuski/admdongkor, CC BY 4.0).
const fs = require('node:fs');
const path = require('node:path');

const SIDO_ALIASES = {
  서울: ['서울', '서울시', '서울특별시'], 부산: ['부산', '부산시', '부산광역시'], 대구: ['대구', '대구시', '대구광역시'],
  인천: ['인천', '인천시', '인천광역시'], 광주: ['광주광역시'], 대전: ['대전', '대전시', '대전광역시'],
  울산: ['울산', '울산시', '울산광역시'], 세종: ['세종', '세종시', '세종특별자치시'], 경기: ['경기', '경기도'],
  강원: ['강원', '강원도', '강원특별자치도'], 충북: ['충북', '충청북도'], 충남: ['충남', '충청남도'],
  전북: ['전북', '전라북도', '전북특별자치도'], 전남: ['전남', '전라남도'], 경북: ['경북', '경상북도'],
  경남: ['경남', '경상남도'], 제주: ['제주', '제주도', '제주특별자치도']
};
const SIDO_WORDS = new Map(Object.entries(SIDO_ALIASES).flatMap(([short, list]) => list.map(w => [w, short])));
const MAX_SPREAD_KM = 15;
// Provinces whose label is often used for the metro city inside them (e.g. "전남 서구" = 광주 서구).
const METRO_FALLBACK = { 전남: '광주', 충남: '대전', 경북: '대구' };
// Districts created after the centroid data (2001-2023). Approximate centres, hand-placed.
const EXTRA_PLACES = [
  ['인천', '제물포구', 37.4747, 126.6216],
  ['인천', '영종구', 37.4920, 126.4930],
  ['인천', '검단구', 37.5946, 126.6773],
  ['인천', '서해구', 37.5450, 126.6760],
  ['부산', '부산진구', 35.1630, 129.0532]
];

function sggKeys(word) {
  const keys = new Set([word]);
  if (word.length >= 3 && /[시군구]$/.test(word)) keys.add(word.slice(0, -1));
  return keys;
}

function dongKeys(word) {
  const keys = new Set([word]);
  let w = word.replace(/출장소$/, '');
  const digit = w.search(/\d/);
  if (digit > 0) w = w.slice(0, digit).replace(/제$/, '');
  else if (w.length >= 3 && /[동읍면리가]$/.test(w)) w = w.slice(0, -1);
  if (w.length >= 2) keys.add(w);
  return keys;
}

function tokenKeys(token) {
  return new Set([...sggKeys(token), ...dongKeys(token)]);
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function createResolver(placesPath = path.join(__dirname, 'geo', 'kr-places.json')) {
  const raw = JSON.parse(fs.readFileSync(placesPath, 'utf8'));
  for (const [sido, name, lat, lng] of EXTRA_PLACES) raw.places.push(['sgg', sido, name, '', lat, lng]);
  const sidoCentre = new Map(raw.places.filter(p => p[0] === 'sido').map(p => [p[1], { lat: p[4], lng: p[5] }]));
  const places = [];
  const byKey = new Map(); // key -> places whose OWN (most specific) name has that key
  for (const [level, sido, sgg, dong, lat, lng] of raw.places) {
    if (level === 'sido') continue;
    const sggWords = sgg.split(' ').filter(Boolean);
    if (!sggWords.length) continue;
    const own = level === 'dong' ? [...dongKeys(dong)] : [...sggKeys(sggWords[sggWords.length - 1])];
    const parent = new Set(level === 'dong' ? sggWords.flatMap(w => [...sggKeys(w)]) : sggWords.slice(0, -1).flatMap(w => [...sggKeys(w)]));
    const words = (level === 'dong' ? sggWords.length + 1 : sggWords.length);
    if (sgg === '부산진구') own.push('진구');
    const place = { level, sido, sgg, dong, lat, lng, own: new Set(own), parent, words };
    places.push(place);
    for (const k of own) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(place); }
  }
  const cache = new Map();

  function resolve(sido, text) {
    const cacheKey = `${sido || ''}|${text || ''}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const result = compute(sido, text);
    cache.set(cacheKey, result);
    return result;
  }

  function compute(sido, text) {
    if (!text) return null;
    let area = sido || null;
    const tokens = [];
    const seenSido = new Set();
    for (const t of String(text).split(/[\s/·,()[\]]+/).filter(Boolean)) {
      // a repeated province word is the city of the same name ("제주 제주" = 제주시)
      if (SIDO_WORDS.has(t) && !seenSido.has(SIDO_WORDS.get(t))) { seenSido.add(SIDO_WORDS.get(t)); area = area || SIDO_WORDS.get(t); continue; }
      tokens.push(t);
    }
    const found = match(area, tokens) || (METRO_FALLBACK[area] ? match(METRO_FALLBACK[area], tokens) : null);
    if (found) return found;
    if (area === '세종' && sidoCentre.has('세종')) return { ...sidoCentre.get('세종'), level: 'sgg', label: '세종' };
    return null;
  }

  function match(area, tokensIn) {
    const tokens = [...tokensIn];
    // "광주" alone is ambiguous (광주광역시 vs 경기 광주시); keep it as a token unless sido says 광주광역시
    if (area === '광주') { const i = tokens.indexOf('광주'); if (i >= 0) tokens.splice(i, 1); }
    if (!tokens.length) return null;
    const tokenSets = tokens.map(tokenKeys);
    // candidates: places whose own name matches some token
    const candidates = new Set();
    for (const ks of tokenSets) for (const k of ks) for (const p of byKey.get(k) || []) candidates.add(p);
    let best = [], bestScore = -1;
    for (const p of candidates) {
      if (area && p.sido !== area) continue;
      let score = 0, ownHit = false;
      for (const ks of tokenSets) {
        const own = [...ks].some(k => p.own.has(k));
        const parent = [...ks].some(k => p.parent.has(k));
        if (own) ownHit = true;
        if (own || parent) score++;
      }
      if (!ownHit) continue;
      // prefer more tokens matched, then fewer unmatched name parts
      const rank = score * 10 - (p.words - Math.min(p.words, score));
      if (rank > bestScore) { bestScore = rank; best = [p]; }
      else if (rank === bestScore) best.push(p);
    }
    let parentOnly = false;
    if (!best.length) {
      parentOnly = true;
      // parent-only match: city with sub-districts ("수원" -> 수원시 장안/권선/팔달/영통구); average its districts
      for (const p of places) {
        if (p.level !== 'sgg' || (area && p.sido !== area)) continue;
        if (tokenSets.some(ks => [...ks].some(k => p.parent.has(k)))) best.push(p);
      }
      if (!best.length) return null;
    }
    const lat = best.reduce((s, p) => s + p.lat, 0) / best.length;
    const lng = best.reduce((s, p) => s + p.lng, 0) / best.length;
    const spread = Math.max(...best.map(p => distanceKm(lat, lng, p.lat, p.lng)));
    if (spread > (parentOnly ? 25 : MAX_SPREAD_KM)) return null; // ambiguous (e.g. "북구" with no sido)
    const top = best[0];
    const label = [top.sido, top.sgg, best.every(p => p.level === 'dong') && best.length === 1 ? top.dong : ''].filter(Boolean).join(' ');
    return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, level: best.every(p => p.level === 'dong') ? 'dong' : 'sgg', label };
  }

  return { resolve, attribution: raw.attribution };
}

module.exports = { createResolver, distanceKm };
