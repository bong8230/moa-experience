'use strict';
// Store addresses read from the campaign's own original page (visit campaigns only).
//
// Only the page's visit-place section is read; never the first address on the page, the platform's
// footer (its company address), HTML comments, scripts or styles. An address is accepted only when it
// is a Korean street address (sido + sigungu + road/lot number); otherwise nothing is shown.
//   - 디너의여왕: <span>방문 위치</span>: <!-- old copy --> {address} </p>, marker new naver.maps.LatLng(lat, lng),
//     place link in #detailPlaceLink. Product campaigns have no such section.
//   - 강남맛집:   <dt>방문 및 예약</dt><dd> … <div id="cont_map"></div> <div> {address [store name]} </div></dd>,
//     the same text in `var loca = "…"`. Its map script centre (33.450701, 126.570667) is a placeholder, not the store.
// Raw HTML is never kept: callers store only { address, lat, lng, mapUrl }.

const SIDO = {
  서울: '서울', 서울시: '서울', 서울특별시: '서울', 부산: '부산', 부산광역시: '부산', 대구: '대구', 대구광역시: '대구',
  인천: '인천', 인천광역시: '인천', 광주: '광주', 광주광역시: '광주', 대전: '대전', 대전광역시: '대전',
  울산: '울산', 울산광역시: '울산', 세종: '세종', 세종시: '세종', 세종특별자치시: '세종', 경기: '경기', 경기도: '경기',
  강원: '강원', 강원도: '강원', 강원특별자치도: '강원', 충북: '충북', 충청북도: '충북', 충남: '충남', 충청남도: '충남',
  전북: '전북', 전라북도: '전북', 전북특별자치도: '전북', 전남: '전남', 전라남도: '전남', 경북: '경북', 경상북도: '경북',
  경남: '경남', 경상남도: '경남', 제주: '제주', 제주도: '제주', 제주특별자치도: '제주'
};
// map links shown to users: https only, these hosts only (no query-string tricks needed for any of them)
const MAP_HOSTS = new Set(['naver.me', 'map.naver.com', 'm.map.naver.com', 'place.naver.com', 'm.place.naver.com', 'map.kakao.com', 'place.map.kakao.com', 'kko.to']);
const PLACEHOLDER_CENTRE = '33.450701,126.570667'; // Kakao Maps sample centre, used by 강남맛집 before geocoding

// unterminated comment: everything after it is hidden too
const withoutComments = html => String(html).replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
// sections are looked for in what the browser shows: never inside script/style/template/… text
const RAW_TEXT = /<(script|style|template|noscript|textarea|xmp|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
// the page's own scripts (map marker, geocoder input) are read only from <script> bodies
const SCRIPTS = /<script\b[^>]*>([\s\S]*?)(?:<\/script\s*>|$)/gi;
function split(page) {
  const html = withoutComments(page);
  return { visible: html.replace(RAW_TEXT, ' '), scripts: [...html.matchAll(SCRIPTS)].map(m => m[1]).join('\n') };
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'" };
function textOf(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#0?39);/g, m => ENTITIES[m])
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ROAD = /^\S*\d*\S*(?:로|길)$/;            // 증안로22번길, 올림픽로10길, 테헤란로
const ROAD_SUB = /^\d+(?:번)?길$/;               // "테헤란로 37길"
const LOT_AREA = /^\S+(?:동|읍|면|리|가)$/;       // 신천동, 종로1가, 물금읍, 증산리
const NUMBER = /^(?:산\s?)?\d{1,5}(?:-\d{1,5})?$/;
const DETAIL = /^(?:(?:지하|B)?\d{1,3}(?:~\d{1,3})?층|\d{1,5}(?:-\d{1,5})?호|일부호|\d{1,4}동|상가|지상|\(.{1,30}\))$/;

// "경남 양산시 삼호동 1011 2층 초량 갈비쌈냉면 양산웅상점" -> { address: "경남 양산시 삼호동 1011 2층", sido: "경남" }
// The leading sido + sigungu + (road name + building number | lot area + lot number) is required;
// floor/unit words right after it are kept; anything after that (a store name, repeats) is dropped.
function streetAddress(text) {
  const words = String(text || '').replace(/,/g, ' ').split(' ').filter(Boolean);
  if (words.length < 3 || words.length > 40) return null;
  const sido = SIDO[words[0]];
  if (!sido) return null;
  let i = 1;
  let sigungu = 0;
  while (i < words.length && sigungu < 2 && /^\S+(?:시|군|구)$/.test(words[i]) && !ROAD.test(words[i])) { i++; sigungu++; }
  if (!sigungu && sido !== '세종') return null;
  let ok = false;
  if (i < words.length && ROAD.test(words[i]) && !LOT_AREA.test(words[i])) {
    i++;
    if (i < words.length && ROAD_SUB.test(words[i])) i++;
    if (i < words.length && NUMBER.test(words[i])) { i++; ok = true; }
  } else {
    let areas = 0;
    while (i < words.length && areas < 2 && LOT_AREA.test(words[i])) { i++; areas++; }
    if (areas && i < words.length && words[i] === '산' && NUMBER.test(words[i + 1] || '')) i++;
    if (areas && i < words.length && NUMBER.test(words[i])) { i++; ok = true; }
  }
  if (!ok) return null;
  let details = 0;
  while (i < words.length && details < 3 && DETAIL.test(words[i])) { i++; details++; }
  const address = words.slice(0, i).join(' ');
  return address.length <= 120 ? { address, sido } : null;
}

function safeMapUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !MAP_HOSTS.has(u.hostname)) return null;
    return u.href.length <= 300 ? u.href : null;
  } catch { return null; }
}

function coords(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!(a >= 33 && a <= 39 && b >= 124 && b <= 132)) return null;
  if (`${a},${b}` === PLACEHOLDER_CENTRE) return null;
  return { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 };
}

// every copy of a block must give the same answer; none -> 'none', disagreement -> 'mismatch'
function single(values) {
  const set = new Set(values);
  if (!set.size) return { status: 'none' };
  if (set.size > 1) return { status: 'mismatch' };
  return { status: 'ok', value: [...set][0] };
}

// -> { status: 'found', address, sido, lat?, lng?, mapUrl? } | { status: 'none' | 'unparsed' | 'mismatch' }
function parseDinnerqueenPlace(page) {
  if (typeof page !== 'string' || !page) return { status: 'unparsed' };
  const { visible: html, scripts } = split(page); // a section, marker or link inside <!-- --> is not on the page
  const blocks = [...html.matchAll(/<span>\s*방문 위치\s*<\/span>\s*:([\s\S]{0,2000}?)<\/p>/g)].map(m => textOf(m[1]));
  const found = single(blocks);
  if (found.status !== 'ok') return { status: found.status };
  const street = streetAddress(found.value);
  if (!street) return { status: 'unparsed' };
  const out = { status: 'found', ...street };
  // marker of the visit map; any other coordinate literal on the page is ignored
  if (/id="map-canvas"/.test(html)) {
    const points = single([...scripts.matchAll(/new naver\.maps\.LatLng\(\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\)/g)].map(m => `${m[1]},${m[2]}`));
    const c = points.status === 'ok' ? coords(...points.value.split(',')) : null;
    if (c) Object.assign(out, c);
  }
  const links = single([...html.matchAll(/id="detailPlaceLink"[^>]*>\s*<strong[^>]*>([^<]{1,300})<\/strong>/g)].map(m => m[1].trim()));
  const mapUrl = links.status === 'ok' ? safeMapUrl(links.value) : null;
  if (mapUrl) out.mapUrl = mapUrl;
  return out;
}

// -> { status: 'found', address, sido, mapUrl? } | { status: 'none' | 'unparsed' | 'mismatch' }
function parseGangnamPlace(page) {
  if (typeof page !== 'string' || !page) return { status: 'unparsed' };
  const { visible: html, scripts } = split(page);
  const visible = [...html.matchAll(/<dt>\s*방문 및 예약\s*<\/dt>\s*<dd[^>]*>([\s\S]{0,6000}?)<\/dd>/g)]
    .map(m => (m[1].match(/id="cont_map"[^>]*>\s*<\/div>\s*<div[^>]*>([\s\S]{0,600}?)<\/div>/) || [])[1])
    .filter(v => v !== undefined).map(textOf).filter(Boolean);
  const found = single(visible);
  if (found.status !== 'ok') return { status: found.status };
  // the map script geocodes the same text; when present it has to agree
  const loca = [...scripts.matchAll(/var loca = "([^"\\]{0,600})"/g)].map(m => textOf(m[1])).filter(Boolean);
  if (loca.length && loca.some(v => v !== found.value)) return { status: 'mismatch' };
  const street = streetAddress(found.value);
  if (!street) return { status: 'unparsed' };
  const out = { status: 'found', ...street };
  const links = single([...html.matchAll(/<dt>\s*플레이스 URL\s*<\/dt>[\s\S]{0,600}?href="([^"]{1,300})"/g)].map(m => m[1].trim()));
  const mapUrl = links.status === 'ok' ? safeMapUrl(links.value) : null;
  if (mapUrl) out.mapUrl = mapUrl;
  return out;
}

// What a stored page check contributes to a campaign: only a found address whose province matches the
// campaign's own region (when the campaign has one). Anything weaker shows no address.
// Only visit campaigns (or legacy snapshots without a type) qualify; a delivery/press/purchase campaign
// never shows a stored visit address, and neither does a hand-added one.
function placeFields(entry, record) {
  if (!record || record.manual || (record.type && record.type !== '방문형')) return null;
  const p = entry && entry.place;
  if (!p || p.status !== 'found' || !p.address) return null;
  if (record.region_sido && p.sido && record.region_sido !== p.sido) return null;
  return {
    address: p.address, addressOrigin: 'campaign', addressSourceUrl: entry.url, addressCheckedAt: entry.checkedAt,
    mapUrl: p.mapUrl || null
  };
}

module.exports = { parseDinnerqueenPlace, parseGangnamPlace, streetAddress, safeMapUrl, placeFields, textOf };
