'use strict';
// Saved list filters per Kakao account (GET/PUT /api/preferences).
// The whole object is replaced on every save; an explicit reset is saved as the empty filter.
// Coordinates are rounded to 3 decimals (about 100 m), the same precision /api/campaigns accepts,
// so a raw GPS position is never stored.

const RADII = [3, 5, 10, 20, 30];
const SORTS = ['deadline', 'distance'];
const LIMITS = { categories: 30, sources: 40, channels: 20, regions: 20 };
const VALUE_MAX = 60;
const Q_MAX = 100;
const LABEL_MAX = 50;
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u;

const EMPTY = Object.freeze({ categories: [], sources: [], channels: [], regions: [], q: '', near: null, radius: 10, includeNoLoc: false, sort: 'deadline' });
const emptyPreferences = () => ({ ...EMPTY, categories: [], sources: [], channels: [], regions: [] });
const round3 = n => Math.round(n * 1000) / 1000;

function cleanText(value, max, field) {
  if (typeof value !== 'string') return { error: `${field} 값은 글자여야 합니다.` };
  if (BAD_CHARS.test(value)) return { error: `${field}에 쓸 수 없는 문자가 있습니다.` };
  const text = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if ([...text].length > max) return { error: `${field}은(는) ${max}자 이하로 입력하세요.` };
  return { text };
}

// Missing fields take their default; present fields must have the right type. Unknown fields are ignored.
function validatePreferences(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '요청 형식이 올바르지 않습니다.' };
  const out = emptyPreferences();
  for (const [field, limit] of Object.entries(LIMITS)) {
    if (body[field] === undefined) continue;
    if (!Array.isArray(body[field])) return { error: `${field}는 목록이어야 합니다.` };
    if (body[field].length > limit) return { error: `${field}는 ${limit}개까지 고를 수 있습니다.` };
    const values = [];
    for (const item of body[field]) {
      const c = cleanText(item, VALUE_MAX, field);
      if (c.error) return c;
      if (!c.text) return { error: `${field}에 빈 값이 있습니다.` };
      if (field === 'sources' && !/^[a-z0-9_-]{1,40}$/i.test(c.text)) return { error: '체험단 사이트 값이 올바르지 않습니다.' };
      if (!values.includes(c.text)) values.push(c.text);
    }
    out[field] = values;
  }
  if (body.q !== undefined) {
    const c = cleanText(body.q, Q_MAX, '검색어');
    if (c.error) return c;
    out.q = c.text;
  }
  if (body.near !== undefined && body.near !== null) {
    const n = body.near;
    if (typeof n !== 'object' || Array.isArray(n)) return { error: '기준 위치 형식이 올바르지 않습니다.' };
    const label = cleanText(n.label, LABEL_MAX, '기준 위치 이름');
    if (label.error) return label;
    if (!label.text) return { error: '기준 위치 이름이 비어 있습니다.' };
    if (typeof n.lat !== 'number' || typeof n.lng !== 'number' || !Number.isFinite(n.lat) || !Number.isFinite(n.lng)) return { error: '기준 위치 좌표가 올바르지 않습니다.' };
    const lat = round3(n.lat), lng = round3(n.lng);
    if (lat < 33 || lat > 39 || lng < 124 || lng > 132) return { error: '기준 위치는 국내 좌표만 저장할 수 있습니다.' };
    out.near = { label: label.text, lat, lng };
  }
  if (body.radius !== undefined) {
    if (!RADII.includes(body.radius)) return { error: `반경은 ${RADII.join(', ')}km 중 하나여야 합니다.` };
    out.radius = body.radius;
  }
  if (body.includeNoLoc !== undefined) {
    if (typeof body.includeNoLoc !== 'boolean') return { error: 'includeNoLoc 값이 올바르지 않습니다.' };
    out.includeNoLoc = body.includeNoLoc;
  }
  if (body.sort !== undefined) {
    if (!SORTS.includes(body.sort)) return { error: '정렬 값이 올바르지 않습니다.' };
    out.sort = body.sort;
  }
  return { preferences: out };
}

module.exports = { validatePreferences, emptyPreferences, RADII };
