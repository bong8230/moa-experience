'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createResolver, distanceKm } = require('./geo.js');
const { createPlaceLocator } = require('./kakao-local.js');
const { createMetrics } = require('./metrics.js');
const { validatePreferences } = require('./preferences.js');
const { createDeadlineVerifier } = require('./deadlines.js');
const { safeMapUrl } = require('./addresses.js');

const SOURCE_URL = 'https://raw.githubusercontent.com/Richophie/review_search/main/public/data/campaigns.json';
const CACHE_MS = 30 * 60 * 1000;
const RECENT_MS = 48 * 3600 * 1000;
const SESSION_MS = 7 * 24 * 3600 * 1000;
const STATE_MS = 10 * 60 * 1000;
const PAGE_SIZE = 50;
const NATIONWIDE = '전국';
const APPLICATION_STAGES = ['applied', 'selected', 'reviewed'];

function matchesFilters(record, { categories, sources, regions, channels, q }) {
  return (!categories.length || categories.includes(record.category)) &&
    (!sources.length || sources.includes(record.source)) &&
    (!regions.length || regions.includes(record.region_sido || NATIONWIDE)) &&
    (!channels.length || (record.channels.length ? record.channels : ['미확인']).some(c => channels.includes(c))) &&
    (!q || `${record.title || ''} ${record.source || ''} ${record.region_text || ''}`.toLowerCase().includes(q));
}

function validScheduleDate(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const FORBIDDEN_HOSTS = new Set(['', '0.0.0.0', '::', '[::]', '*']);
const KAKAO_AUTHORIZE = 'https://kauth.kakao.com/oauth/authorize';
const KAKAO_TOKEN = 'https://kauth.kakao.com/oauth/token';
const KAKAO_ME = 'https://kapi.kakao.com/v2/user/me';

function kstToday(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

function normalize(r) {
  return {
    id: r.id, source: r.source_id, title: r.title, url: r.original_url, category: r.category || '기타',
    benefit: r.benefit, deadline: r.apply_deadline, precision: r.deadline_precision,
    firstSeen: r.first_seen_at || r.published_at || null,
    applicants: r.applicants, slots: r.slots, lastSeen: r.last_seen_at, type: r.campaign_type,
    region_sido: r.region_sido || null, region_text: r.region_text || null,
    channels: Array.isArray(r.channels) ? r.channels.filter(c => typeof c === 'string' && c.trim()) : []
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, path: p = '/', secure = false } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  if (secure) s += '; Secure';
  return s;
}

function safeReturn(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value.slice(0, 500);
}

function withQuery(returnTo, key, value) {
  const u = new URL(returnTo, 'http://local');
  u.searchParams.set(key, value);
  return u.pathname + u.search;
}

// Platforms the user can only reach by hand (no automated collection). Detected from the pasted URL.
const MANUAL_PLATFORMS = [
  { key: 'musinsa', hosts: ['musinsa.com'] },
  { key: 'kakao-gift', hosts: ['gift.kakao.com'] },
  { key: 'coupang', hosts: ['coupang.com'] },
  { key: 'enjoeat', hosts: ['enjoeat.com'] }
];

function detectPlatform(hostname) {
  const host = hostname.toLowerCase();
  const hit = MANUAL_PLATFORMS.find(p => p.hosts.some(h => host === h || host.endsWith('.' + h)));
  return hit ? hit.key : 'other';
}

function validateManual(body) {
  if (!body || typeof body !== 'object') return { error: '요청 형식이 올바르지 않습니다.' };
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 120) return { error: '제목을 1~120자로 입력하세요.' };
  // url is optional: Kakao gift / Coupang invites often have no shareable web link.
  let url = null;
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (rawUrl) {
    try { url = new URL(rawUrl); } catch { return { error: '공고 링크를 https:// 로 시작하는 주소로 입력하세요.' }; }
    if (url.protocol !== 'https:' || url.href.length > 500) return { error: '공고 링크를 https:// 로 시작하는 주소로 입력하세요.' };
  }
  const allowed = [...MANUAL_PLATFORMS.map(p => p.key), 'other'];
  const platform = allowed.includes(body.platform) ? body.platform : null;
  if (!url && !platform) return { error: '공고 링크나 플랫폼 중 하나는 입력하세요.' };
  const deadline = body.deadline ? String(body.deadline) : null;
  if (deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(deadline)))) return { error: '마감일은 YYYY-MM-DD 형식으로 입력하세요.' };
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  return {
    item: {
      title, url: url ? url.href : null,
      source: platform && platform !== 'other' ? platform : url ? detectPlatform(url.hostname) : 'other', deadline,
      region_sido: null, region_text: null, category: '기타', channels: [], note
    }
  };
}

// App nickname: 2-20 characters after trimming; runs of spaces collapse to one.
// Control and invisible format characters (bidi overrides, zero-width) are rejected; ZWJ stays for emoji.
// Stored as plain text and escaped when rendered. Nicknames are not unique: two accounts may share one.
const NICK_MIN = 2, NICK_MAX = 20;
function validateNickname(value) {
  if (typeof value !== 'string') return { error: '닉네임을 입력하세요.' };
  const raw = value.normalize('NFC');
  if (/(?!\u200D)[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u.test(raw)) return { error: '줄바꿈이나 보이지 않는 문자는 닉네임에 쓸 수 없어요.' };
  const nickname = raw.replace(/\p{Zs}+/gu, ' ').trim();
  const length = [...nickname].length;
  if (length < NICK_MIN || length > NICK_MAX) return { error: `닉네임은 ${NICK_MIN}~${NICK_MAX}자로 입력하세요.` };
  return { nickname };
}

// Owner dashboard access comes only from the ADMIN_KAKAO_IDS env (comma separated Kakao user ids,
// "12345" or "kakao:12345"). Nothing else grants it: no first-user promotion, no nickname match.
function parseAdminIds(value) {
  const ids = new Set();
  for (const part of String(value || '').split(/[\s,]+/)) {
    const m = /^(?:kakao:)?(\d{1,20})$/.exec(part.trim());
    if (m) ids.add(`kakao:${m[1]}`);
  }
  return ids;
}

const CAMPAIGN_ID = /^[a-z0-9_-]{1,40}:[^\s/]{1,160}$/i;
const ADMIN_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function plainPage(title, message, link) {
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#F2F4F8;color:#16213A;font:15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}main{max-width:420px;margin:15vh auto 0;padding:0 16px}h1{font-size:20px;margin:0 0 8px}a{color:#2347C5}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="${esc(link.href)}">${esc(link.text)}</a></p></main></body></html>`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createApp(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const now = options.now || Date.now;
  const sourceUrl = options.sourceUrl || SOURCE_URL;
  const favoritesPath = options.favoritesPath || path.join(__dirname, 'data', 'favorites.json');
  const indexPath = options.indexPath || path.join(__dirname, 'index.html');
  const adminPath = options.adminPath || path.join(__dirname, 'admin.html');
  const env = options.env || process.env;
  const store = options.store || (env.DATABASE_URL ? require('./postgres-store.js').createPostgresStore({ connectionString: env.DATABASE_URL, now }) : null);
  const kakao = {
    restApiKey: env.KAKAO_REST_API_KEY || '',
    clientSecret: env.KAKAO_CLIENT_SECRET || '',
    redirectUri: env.KAKAO_REDIRECT_URI || ''
  };
  const authEnabled = Boolean(kakao.restApiKey && kakao.redirectUri);
  const adminIds = parseAdminIds(env.ADMIN_KAKAO_IDS);
  const resolver = options.resolver || createResolver();
  // optional precise store coordinates (Kakao Local); null -> region centroids only
  // verified application deadlines from original pages (dinnerqueen only); options.deadlines === false disables
  const deadlines = options.deadlines === false || env.DEADLINE_VERIFY === '0' ? null
    : options.deadlines || createDeadlineVerifier({ store, filePath: options.deadlinesPath || path.join(path.dirname(options.favoritesPath || path.join(__dirname, 'data', 'favorites.json')), 'deadlines.json'), fetch: fetchImpl, now, log: m => console.error(m) });
  // work that may finish after the response: Vercel's waitUntil, or nothing to do in a long-running process
  const afterResponse = options.waitUntil || (env.VERCEL ? null : () => {});
  let deadlineRun = null, lastDeferred = null; // a deferral reason is logged once, not on every request
  const places = options.places || (store && kakao.restApiKey && env.KAKAO_LOCAL !== '0' ? require('./serverless-places.js').createServerlessPlaces({ store, key: kakao.restApiKey, fetch: fetchImpl, now }) : null);

  let cache = null;
  let fetchedAt = 0;
  let refreshHealth = null;
  async function saveRefreshHealth(value) {
    refreshHealth = value;
    try { await store?.set('cache', '', 'refresh-health', value); } catch (err) { console.error('[server] refresh status not saved:', err.code || 'error'); }
  }
  let pending = null;
  const sessions = new Map();
  const states = new Map();
  // Shared list cache in the DB: campaigns seen in the last 48 h, gzip+base64 in one row. Estimated dates
  // never discard a record here: verified deadline overlays decide list expiry later. Older rows ({ records: [...] }) are still read.
  function packCache(c) {
    return { fetchedAt: c.fetchedAt, count: c.records.length, gz: zlib.gzipSync(JSON.stringify(c.records)).toString('base64') };
  }
  function restoreCache(shared) {
    const stored = shared.gz ? JSON.parse(zlib.gunzipSync(Buffer.from(shared.gz, 'base64')).toString('utf8')) : shared.records;
    // A cache built before Kakao was configured still gets precise-location keys on later instances.
    const records = stored.map(r => ({ ...r, placeKey: places && r.lat !== null ? places.keyFor(r, { lat: r.lat, lng: r.lng, level: r.geoLevel, label: r.geoLabel }) : null }));
    return { fetchedAt: shared.fetchedAt, records, byId: new Map(records.map(r => [r.id, r])) };
  }
  function adopt(next) { cache = next; fetchedAt = Date.parse(next.fetchedAt); return cache; }
  function canServeStale(c) {
    const t = now();
    return c.records.some(r => r.lastSeen && t - Date.parse(r.lastSeen) <= RECENT_MS);
  }

  // Download and rebuild from the source. With a store, only the instance holding the lease does it
  // (returns null when another instance is already refreshing).
  async function refreshFromSource() {
    let lease;
    if (store) {
      lease = crypto.randomBytes(16).toString('hex');
      if (!await store.acquire('campaigns', lease, now() + 45000)) return null;
    }
    const attemptedAt = new Date(now()).toISOString();
    try {
      const response = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
      const records = await response.json();
      if (!Array.isArray(records)) throw new Error('Unexpected source format');
      const t = now(), today = kstToday(t);
      const next = { fetchedAt: new Date(t).toISOString(), records: records.map(normalize)
        .filter(n => n.lastSeen && t - Date.parse(n.lastSeen) <= RECENT_MS)
        .map(n => {
          // approximate location from region text -> administrative-area centroid (dong or sigungu level)
          const g = resolver.resolve(n.region_sido, n.region_text);
          if (!g) return { ...n, lat: null, lng: null, geoLevel: null, placeKey: null };
          return { ...n, lat: g.lat, lng: g.lng, geoLevel: g.level, placeKey: places ? places.keyFor(n, g) : null, geoLabel: g.label };
        }) };
      next.byId = new Map(next.records.map(r => [r.id, r]));
      adopt(next);
      if (store) {
        await store.set('cache', '', 'campaigns', packCache(next));
        await store.prune?.();
      }
      if (places) {
        places.enqueue(next.records
          .filter(r => r.placeKey)
          .map(r => ({ key: r.placeKey, record: r, centroid: { lat: r.lat, lng: r.lng, level: r.geoLevel, label: r.geoLabel } })));
      }
      await saveRefreshHealth({ attemptedAt, success: true });
      return next;
    } catch (err) {
      const http = /^Source HTTP (\d{3})$/.exec(err.message || '');
      const reason = http ? `HTTP ${http[1]}` : err.name === 'TimeoutError' ? 'timeout' : err instanceof SyntaxError || err.message === 'Unexpected source format' ? 'format' : err.code ? 'storage' : 'connection';
      await saveRefreshHealth({ attemptedAt, success: false, reason });
      throw err;
    } finally { if (store && lease) await store.release('campaigns', lease); }
  }

  // Address shown on a campaign: the original page's visit section (deadlines.apply, addressOrigin 'campaign')
  // wins; otherwise a Kakao Local hit for a visit campaign (addressOrigin 'kakao', shown as a search result).
  // Delivery and hand-added campaigns never get one. Nothing is guessed when neither exists.
  const ADDRESS_FIELDS = ['address', 'addressOrigin', 'addressSourceUrl', 'addressCheckedAt', 'mapUrl'];
  function withKakaoAddress(item, placeKey) {
    if (item.address || item.manual || !places || (item.type && item.type !== '방문형')) return item;
    const live = cache?.byId.get(item.id);
    const type = item.type || live?.type;
    const pl = type === '방문형' ? places.get(placeKey !== undefined ? placeKey : live?.placeKey) : null;
    if (!pl || typeof pl.address !== 'string' || !pl.address) return item;
    return {
      ...item, address: pl.address, addressOrigin: 'kakao', addressSourceUrl: safeMapUrl(pl.url),
      addressCheckedAt: Number.isFinite(pl.t) ? new Date(pl.t).toISOString() : null, mapUrl: safeMapUrl(pl.url)
    };
  }
  // Before favorites/marks are shown: the shared campaign list (DB row only, never the source download) for the
  // current types, and the stored Kakao hits (read-only, no Kakao request). Failures just mean fewer addresses.
  async function addressContext() {
    if (!cache && store) {
      try { const shared = await store.get('cache', '', 'campaigns'); if (shared && !cache) adopt(restoreCache(shared)); }
      catch (err) { console.error('[server] list cache not read:', err.code || 'error'); }
    }
    if (places?.loadCached) { try { await places.loadCached(); } catch {} }
  }
  // favorites/marks keep the address they were saved with; a newer check replaces it
  const addressOf = item => Object.fromEntries(ADDRESS_FIELDS.map(k => [k, item[k] ?? null]));
  function withAddress(snapshot, known) {
    // the current source type wins over a saved snapshot's (older snapshots may have none or an outdated one);
    // when the campaign is not in the current list its type is unknown, so no address is shown
    const live = snapshot.manual ? null : cache?.byId.get(snapshot.id);
    const item = live?.type && live.type !== snapshot.type ? { ...snapshot, type: live.type } : snapshot;
    const out = withKakaoAddress(deadlines && known && !item.manual ? deadlines.apply(item, known) : item);
    if (!out.manual && live?.type === '방문형') return out;
    // a saved snapshot's address is dropped once the campaign is known not to be a visit campaign
    const clean = { ...out };
    for (const k of ADDRESS_FIELDS) delete clean[k];
    return clean;
  }

  function locationFor(record, known) {
    const original = known?.get(record.id)?.place;
    if (record.addressOrigin === 'campaign' && original?.lat >= 33 && original.lat <= 39 && original.lng >= 124 && original.lng <= 132) {
      return { lat: original.lat, lng: original.lng, level: 'original' };
    }
    const hit = places?.get(record.placeKey);
    if (hit) return { lat: hit.lat, lng: hit.lng, level: 'place', placeName: hit.name, placeUrl: safeMapUrl(hit.url) };
    return record.lat != null && record.lng != null ? { lat: record.lat, lng: record.lng, level: record.geoLevel } : null;
  }

  function publicCampaign(record) {
    const { lat, lng, placeKey, geoLabel, ...visible } = record;
    return withKakaoAddress(visible, placeKey);
  }

  // Stale-while-revalidate: a stale list is served at once and refreshed after the response.
  // On Vercel the work is kept alive with waitUntil (options.waitUntil); locally the process keeps running.
  let refreshing = null;
  function refreshLater() {
    if (refreshing) return;
    if (refreshHealth?.success === false && now() - Date.parse(refreshHealth.attemptedAt) < 5 * 60e3) return;
    refreshing = (async () => {
      if (store) { // another instance may have refreshed already
        const shared = await store.get('cache', '', 'campaigns');
        if (shared && now() - Date.parse(shared.fetchedAt) < CACHE_MS) { if (Date.parse(shared.fetchedAt) > fetchedAt) adopt(restoreCache(shared)); return; }
      }
      await refreshFromSource();
    })().catch(err => console.error('[server] background refresh failed:', store ? (err.code || 'error') : err.message))
      .finally(() => { refreshing = null; });
    afterResponse(refreshing);
  }

  async function campaigns(force = false) {
    if (!force && cache && now() - fetchedAt < CACHE_MS) return cache;
    if (!force && cache && afterResponse && canServeStale(cache)) { refreshLater(); return cache; }
    if (!pending) {
      pending = (async () => {
        if (!store) return refreshFromSource();
        const shared = await store.get('cache', '', 'campaigns');
        if (shared) {
          const restored = restoreCache(shared);
          const fresh = now() - Date.parse(shared.fetchedAt) < CACHE_MS;
          if (!force && (fresh || (afterResponse && canServeStale(restored)))) { adopt(restored); if (!fresh) refreshLater(); return cache; }
          return (await refreshFromSource()) || adopt(restored); // refresh now; another instance may hold the lease
        }
        const fresh = await refreshFromSource();
        if (!fresh) throw new Error('Source refresh already in progress');
        return fresh;
      })().finally(() => { pending = null; });
    }
    return pending;
  }

  // favorites: { [userId]: { [campaignId]: snapshot } }
  let favorites = {};
  if (!store) try { favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf8')) || {}; } catch { favorites = {}; }
  let writeChain = Promise.resolve();
  function saveFavorites(userId, id, item) {
    if (store) return item ? store.set('favorite', userId, id, item) : store.remove('favorite', userId, id);
    const data = JSON.stringify(favorites, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(favoritesPath), { recursive: true });
      const tmp = `${favoritesPath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, favoritesPath);
    });
    return writeChain;
  }

  // marks: { [userId]: { [campaignId]: { status: 'applied'|'excluded', at, ...snapshot } } }
  const marksPath = options.marksPath || path.join(path.dirname(favoritesPath), 'marks.json');
  let marks = {};
  if (!store) try { marks = JSON.parse(fs.readFileSync(marksPath, 'utf8')) || {}; } catch { marks = {}; }
  function saveMarks(userId, id, item) {
    if (store) return item ? store.set('mark', userId, id, item) : store.remove('mark', userId, id);
    const data = JSON.stringify(marks, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(marksPath), { recursive: true });
      const tmp = `${marksPath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, marksPath);
    });
    return writeChain;
  }

  // profiles: { [userId]: { nickname, updatedAt } }; keyed by Kakao account id, independent of sessions
  const profilesPath = options.profilesPath || path.join(path.dirname(favoritesPath), 'profiles.json');
  let profiles = {};
  if (!store) try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) || {}; } catch { profiles = {}; }
  const getProfile = userId => store ? store.get('profile', userId, 'main') : Promise.resolve(profiles[userId] || null);
  function saveProfile(userId, profile) {
    if (store) return store.set('profile', userId, 'main', profile);
    profiles[userId] = profile;
    const data = JSON.stringify(profiles, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(profilesPath), { recursive: true });
      const tmp = `${profilesPath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, profilesPath);
    });
    return writeChain;
  }

  // saved list filters: { [userId]: { ...filters, updatedAt } }; separate from profile/favorites/marks
  const preferencesPath = options.preferencesPath || path.join(path.dirname(favoritesPath), 'preferences.json');
  let preferences = {};
  if (!store) try { preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) || {}; } catch { preferences = {}; }
  const getPreferences = userId => store ? store.get('preferences', userId, 'filters') : Promise.resolve(preferences[userId] || null);
  function savePreferences(userId, value) {
    if (store) return store.set('preferences', userId, 'filters', value);
    preferences[userId] = value;
    const data = JSON.stringify(preferences, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(preferencesPath), { recursive: true });
      const tmp = `${preferencesPath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, preferencesPath);
    });
    return writeChain;
  }

  const metrics = createMetrics({ store, filePath: options.metricsPath || path.join(path.dirname(favoritesPath), 'metrics.json'), now });
  async function allNicknames() {
    if (!store) return new Map(Object.entries(profiles).filter(([, p]) => p?.nickname).map(([id, p]) => [id, p.nickname]));
    return new Map((await store.listScope('profile')).filter(r => r.key === 'main' && r.value?.nickname).map(r => [r.owner, r.value.nickname]));
  }

  const myFavorites = userId => store ? store.list('favorite', userId) : Promise.resolve(favorites[userId] || {});
  const userMarks = userId => store ? store.list('mark', userId) : Promise.resolve(marks[userId] || {});

  function sweep() {
    const t = now();
    for (const [k, v] of sessions) if (v.expires <= t) sessions.delete(k);
    for (const [k, v] of states) if (v.expires <= t) states.delete(k);
  }

  function isSecure(req) {
    const remote = req.socket.remoteAddress || '';
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    return Boolean(req.socket.encrypted) || ((local || env.VERCEL === '1' || env.VERCEL === 'true') && req.headers['x-forwarded-proto'] === 'https');
  }

  async function currentUser(req) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (!sid) return null;
    const s = store ? await store.get('session', '', sid) : sessions.get(sid);
    if (!s || s.expires <= now()) { if (s) sessions.delete(sid); return null; }
    // the saved app nickname wins over the Kakao profile name, so every open session shows the latest one
    const profile = await getProfile(s.user.id);
    return {
      id: s.user.id,
      nickname: profile?.nickname || s.user.nickname || '카카오 사용자',
      nicknameSet: Boolean(profile?.nickname),
      kakaoNickname: s.user.nickname && s.user.nickname !== '카카오 사용자' ? s.user.nickname : null,
      isAdmin: adminIds.has(s.user.id) // decided on the server only
    };
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }
  const fail = (res, status, code, error) => json(res, status, { error, code });

  function redirect(res, location, cookies = []) {
    res.writeHead(302, { Location: location, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
    res.end();
  }

  async function listCampaigns(req, res, url) {
    let data;
    try { data = await campaigns(url.searchParams.get('refresh') === '1'); }
    catch { return fail(res, 502, 'source_unavailable', '공고 데이터를 불러오지 못했습니다.'); }
    const p = url.searchParams;
    const t = now();
    const today = kstToday(t);
    const viewer = await currentUser(req);
    const myMarks = viewer ? await userMarks(viewer.id) : {};
    const offset = Math.max(0, Number.parseInt(p.get('offset'), 10) || 0);
    // Verified deadlines (read from the original page) replace the source's estimate before the expiry
    // filter, the sort and the page cut, so totals and order always use the same dates.
    if (places?.loadCached) { try { await places.loadCached(); } catch {} } // stored hits only, no Kakao request
    let prepared = false;
    let known = deadlines ? await deadlines.verifiedMap() : null;
    const filters = { categories: p.getAll('category'), sources: p.getAll('source'), regions: p.getAll('region'), channels: p.getAll('channel'), q: (p.get('q') || '').trim().toLowerCase() };
    const select = async map => {
      const all = map ? data.records.map(r => deadlines.apply(r, map)) : data.records;
      const recent = all.filter(r => r.lastSeen && t - Date.parse(r.lastSeen) <= RECENT_MS && (!r.deadline || r.deadline >= today));
      const categories = [...new Set(recent.map(r => r.category))].sort();
      const sources = [...new Set(recent.map(r => r.source).filter(Boolean))].sort();
      const regions = [...new Set(recent.map(r => r.region_sido).filter(Boolean))].sort();
      if (recent.some(r => !r.region_sido)) regions.push(NATIONWIDE);
      const channels = [...new Set(recent.flatMap(r => r.channels.length ? r.channels : ['미확인']))].sort();
      // radius search around a point (km). Only campaigns whose region text resolved to a place qualify.
      const lat = Number.parseFloat(p.get('lat')), lng = Number.parseFloat(p.get('lng'));
      const radius = Number.parseFloat(p.get('radius'));
      const near = lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132 && radius > 0 && radius <= 100 ? { lat, lng, radius } : null;
      const includeNoLocation = p.get('noloc') === '1';
      const hiddenCount = recent.filter(r => myMarks[r.id]?.status === 'excluded').length;
      const matches = recent.filter(r => myMarks[r.id]?.status !== 'excluded' && matchesFilters(r, filters));
      let filtered = matches;
      if (near && places?.prepare && !prepared) { prepared = true; await places.prepare(matches, near); } // one lookup per request
      let unlocated = 0;
      if (near) {
        filtered = [];
        for (const r of matches) {
          const location = locationFor(r, map);
          if (!location) { unlocated++; if (includeNoLocation) filtered.push({ ...r, distanceKm: null }); continue; }
          const d = distanceKm(near.lat, near.lng, location.lat, location.lng);
          if (d <= near.radius) filtered.push({ ...r, distanceKm: Math.round(d * 10) / 10, geoLevel: location.level, placeName: location.placeName, placeUrl: location.placeUrl });
        }
      }
      const byDeadline = (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999');
      if (near && p.get('sort') === 'distance') filtered.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || byDeadline(a, b));
      else filtered.sort(byDeadline);
      return { recent, categories, sources, regions, channels, hiddenCount, filtered, unlocated, near, includeNoLocation };
    };
    let view = await select(known);
    let deadlineCheck = null;
    if (deadlines) {
      // a few unverified campaigns, visible page first; the estimate stays until a check succeeds
      const page = view.filtered.slice(offset, offset + PAGE_SIZE);
      const priority = page.find(r => r.source === 'dinnerqueen' && r.type === '방문형' && !r.address);
      const nearbyUnverified = view.near ? view.recent.filter(r => r.source === 'dinnerqueen' && r.type === '방문형' && !r.address && r.lat != null &&
        distanceKm(view.near.lat, view.near.lng, r.lat, r.lng) <= view.near.radius + 3 &&
        matchesFilters(r, filters) && myMarks[r.id]?.status !== 'excluded').slice(0, PAGE_SIZE) : [];
      const candidates = [...(priority ? [priority] : []), ...page, ...nearbyUnverified, ...view.filtered.slice(offset + PAGE_SIZE)];
      if (afterResponse) {
        // checked after this response is sent (Vercel waitUntil / long-running local process); later requests use the result
        deadlineCheck = { mode: 'after_response', started: !deadlineRun };
        if (!deadlineRun) {
          deadlineRun = deadlines.verifySome(candidates, { max: 3, budgetMs: 5000 })
            .then(r => { if (r.deferred && r.deferred !== lastDeferred) console.error(`[deadlines] deferred: ${r.deferred}`); lastDeferred = r.deferred; return r; })
            .catch(err => console.error('[deadlines] check failed:', err.code || err.message))
            .finally(() => { deadlineRun = null; });
          afterResponse(deadlineRun);
        }
      } else {
        // serverless without waitUntil: nothing may outlive the response, so check inline within the budget
        deadlineCheck = await deadlines.verifySome(candidates, { max: 3, budgetMs: 2500 });
        if (deadlineCheck.verified || deadlineCheck.addresses) { known = await deadlines.verifiedMap(); view = await select(known); }
        if (deadlineCheck.deferred) console.error(`[deadlines] deferred: ${deadlineCheck.deferred}`);
      }
    }
    const { categories, sources, regions, channels, hiddenCount, filtered, unlocated, near, includeNoLocation } = view;
    const user = viewer;
    const fav = user ? await myFavorites(user.id) : {};
    const records = filtered.slice(offset, offset + PAGE_SIZE).map(r => {
      const location = locationFor(r, known);
      const place = location?.level === 'place' || location?.level === 'original' ? { geoLevel: location.level, placeName: location.placeName, placeUrl: location.placeUrl } : {};
      return { ...publicCampaign(r), ...place, favorite: Boolean(fav[r.id]), status: myMarks[r.id]?.status || null };
    });
    json(res, 200, {
      fetchedAt: data.fetchedAt, stale: t - Date.parse(data.fetchedAt) >= CACHE_MS, total: filtered.length, excludedHidden: hiddenCount, categories, sources, regions, channels, records,
      near: near ? { radius: near.radius, unlocated, includeNoLocation } : null,
      places: places ? places.stats() : { state: 'off', located: 0, pending: 0 },
      // this request's original-page checks: { candidates, checked, verified, deferred: reason | null }
      deadlineCheck,
      geoAttribution: resolver.attribution
    });
  }

  async function login(req, res, url) {
    if (!authEnabled) return fail(res, 503, 'auth_disabled', '카카오 로그인이 설정되지 않았습니다.');
    sweep();
    const state = crypto.randomBytes(24).toString('base64url');
    const entry = { expires: now() + STATE_MS, returnTo: safeReturn(url.searchParams.get('return')) };
    if (store) await store.set('state', '', state, entry, entry.expires);
    else states.set(state, entry);
    const target = new URL(KAKAO_AUTHORIZE);
    target.searchParams.set('client_id', kakao.restApiKey);
    target.searchParams.set('redirect_uri', kakao.redirectUri);
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('state', state);
    redirect(res, target.href, [cookie('oauth_state', state, { maxAge: STATE_MS / 1000, path: '/auth/kakao', secure: isSecure(req) })]);
  }

  async function callback(req, res, url) {
    if (!authEnabled) return fail(res, 503, 'auth_disabled', '카카오 로그인이 설정되지 않았습니다.');
    const clearState = cookie('oauth_state', '', { maxAge: 0, path: '/auth/kakao', secure: isSecure(req) });
    const state = url.searchParams.get('state') || '';
    const cookieState = parseCookies(req.headers.cookie).oauth_state || '';
    const entry = store ? await store.take('state', '', state) : states.get(state);
    if (state) states.delete(state);
    const valid = entry && entry.expires > now() && cookieState.length === state.length &&
      crypto.timingSafeEqual(Buffer.from(cookieState), Buffer.from(state));
    if (!valid) return redirect(res, '/?login=error&reason=state', [clearState]);
    const returnTo = entry.returnTo;
    if (url.searchParams.get('error') || !url.searchParams.get('code')) {
      return redirect(res, withQuery(returnTo, 'login', 'error') + '&reason=denied', [clearState]);
    }
    let user;
    try {
      const form = new URLSearchParams({
        grant_type: 'authorization_code', client_id: kakao.restApiKey,
        redirect_uri: kakao.redirectUri, code: url.searchParams.get('code')
      });
      if (kakao.clientSecret) form.set('client_secret', kakao.clientSecret);
      const tokenRes = await fetchImpl(KAKAO_TOKEN, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: form.toString(), signal: AbortSignal.timeout(10000)
      });
      if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
      const token = await tokenRes.json();
      if (!token.access_token) throw new Error('token missing');
      const meRes = await fetchImpl(KAKAO_ME, {
        headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000)
      });
      if (!meRes.ok) throw new Error(`me HTTP ${meRes.status}`);
      const me = await meRes.json();
      if (me.id === undefined || me.id === null) throw new Error('user id missing');
      const nickname = me.kakao_account?.profile?.nickname || me.properties?.nickname || null;
      user = { id: `kakao:${me.id}`, nickname: nickname ? String(nickname).slice(0, 50) : null };
    } catch (err) {
      console.error('[auth] kakao login failed:', err.message);
      return redirect(res, withQuery(returnTo, 'login', 'error') + '&reason=kakao', [clearState]);
    }
    sweep();
    const sid = crypto.randomBytes(32).toString('base64url');
    const session = { user, expires: now() + SESSION_MS };
    if (store) await store.set('session', '', sid, session, session.expires);
    else sessions.set(sid, session);
    redirect(res, withQuery(returnTo, 'login', 'ok'), [
      clearState, cookie('sid', sid, { maxAge: SESSION_MS / 1000, secure: isSecure(req) })
    ]);
  }

  async function logout(req, res) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) { if (store) await store.remove('session', '', sid); else sessions.delete(sid); }
    res.writeHead(204, { 'Set-Cookie': cookie('sid', '', { maxAge: 0, secure: isSecure(req) }) });
    res.end();
  }

  async function profileRoute(req, res) {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'login_required', '로그인이 필요합니다.');
    if (req.method === 'GET') return json(res, 200, { user });
    if (req.method !== 'PUT') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    let body;
    try { body = JSON.parse(await readBody(req, 1024)); } catch { return fail(res, 400, 'bad_body', '요청 형식이 올바르지 않습니다.'); }
    const checked = validateNickname(body?.nickname);
    if (checked.error) return fail(res, 400, 'bad_nickname', checked.error);
    await saveProfile(user.id, { nickname: checked.nickname, updatedAt: new Date(now()).toISOString() });
    json(res, 200, { user: await currentUser(req) });
  }

  async function meRoute(req, res) {
    const user = await currentUser(req);
    if (user) {
      // a logged-in app load counts as a visit; metrics must never break login state
      try { await metrics.recordVisit(user); } catch (err) { console.error('[metrics] visit not recorded:', err.code || err.message); }
    }
    json(res, 200, { authEnabled, user });
  }

  // "원본 열기" click. Only the campaign id comes from the client; title/link are the server's own snapshot.
  async function openEventRoute(req, res) {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    let body;
    try { body = JSON.parse(await readBody(req, 512)); } catch { return fail(res, 400, 'bad_body', '요청 형식이 올바르지 않습니다.'); }
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!CAMPAIGN_ID.test(id) || id.startsWith('manual:')) return fail(res, 400, 'bad_id', '잘못된 공고 ID입니다.');
    let data;
    try { data = await campaigns(); } catch { return fail(res, 502, 'source_unavailable', '공고 데이터를 불러오지 못했습니다.'); }
    const r = data.byId.get(id);
    if (!r) return fail(res, 404, 'not_found', '공고를 찾을 수 없습니다.');
    await metrics.recordOpen(r);
    res.writeHead(204); res.end();
  }

  // 401 not logged in, 403 logged in but not listed in ADMIN_KAKAO_IDS
  async function adminStatus(req) {
    const user = await currentUser(req);
    return !user ? 401 : user.isAdmin ? 200 : 403;
  }

  async function adminPage(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    const status = await adminStatus(req);
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': ADMIN_CSP };
    if (status === 401) {
      res.writeHead(401, headers);
      return res.end(plainPage('로그인이 필요해요', '관리자 화면은 로그인한 운영자만 볼 수 있어요.', { href: '/auth/kakao/login?return=%2Fadmin', text: '카카오로 로그인' }));
    }
    if (status === 403) {
      res.writeHead(403, headers);
      return res.end(plainPage('볼 수 없는 화면이에요', '이 계정에는 관리자 권한이 없어요.', { href: '/', text: '모아체험으로 돌아가기' }));
    }
    const html = await fs.promises.readFile(adminPath);
    res.writeHead(200, headers);
    res.end(html);
  }

  async function adminDashboard(req, res, url) {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    const status = await adminStatus(req);
    if (status === 401) return fail(res, 401, 'login_required', '로그인이 필요합니다.');
    if (status === 403) return fail(res, 403, 'forbidden', '관리자 권한이 없습니다.');
    const days = Number(url.searchParams.get('days') || 7);
    if (days !== 7 && days !== 30) return fail(res, 400, 'bad_days', '기간은 7일 또는 30일만 고를 수 있습니다.');
    await addressContext();
    const known = deadlines ? await deadlines.verifiedMap() : null;
    const coverage = new Map();
    const t = now();
    const today = kstToday(t);
    for (const raw of cache?.records || []) {
      if (raw.type !== '방문형' || t - Date.parse(raw.lastSeen) > RECENT_MS) continue;
      const item = known ? deadlines.apply(raw, known) : raw;
      if (item.deadline && item.deadline < today) continue;
      const row = coverage.get(raw.source) || { source: raw.source, visits: 0, original: 0, kakao: 0, originalCoordinates: 0 };
      row.visits++;
      const address = withKakaoAddress(item, raw.placeKey);
      if (address.addressOrigin === 'campaign') row.original++;
      if (address.addressOrigin === 'kakao') row.kakao++;
      if (locationFor(item, known)?.level === 'original') row.originalCoordinates++;
      coverage.set(raw.source, row);
    }
    const health = store ? await store.get('cache', '', 'refresh-health') || refreshHealth : refreshHealth;
    const dashboard = await metrics.dashboard(days, { nicknames: await allNicknames(), adminIds });
    json(res, 200, { ...dashboard, collection: {
      fetchedAt: cache?.fetchedAt || null, stale: !cache || t - fetchedAt >= CACHE_MS,
      lastAttempt: health, coverage: [...coverage.values()].sort((a, b) => b.visits - a.visits)
    } });
  }

  async function digestRoute(req, res, url) {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'login_required', '로그인이 필요합니다.');
    if (req.headers['x-moa-account'] && req.headers['x-moa-account'] !== user.id) return fail(res, 409, 'account_changed', '다른 계정으로 로그인되어 있습니다.');
    const prefs = await getPreferences(user.id);
    const t = now();
    const today = kstToday(t);
    if (!prefs) return json(res, 200, { day: today, configured: false, total: 0, items: [] });
    let data;
    try { data = await campaigns(); } catch { return fail(res, 502, 'source_unavailable', '공고 데이터를 불러오지 못했습니다.'); }
    const summary = url.searchParams.get('summary') === '1';
    const [marks, favorites, known] = await Promise.all([userMarks(user.id), summary ? {} : myFavorites(user.id), deadlines?.verifiedMap()]);
    await places?.loadCached?.();
    const start = Date.parse(`${today}T00:00:00+09:00`);
    const filters = { ...prefs, q: prefs.q.toLowerCase() };
    const items = [];
    let total = 0;
    for (const raw of data.records) {
      const first = Date.parse(raw.firstSeen);
      if (!(first >= start && first <= t) || !(t - Date.parse(raw.lastSeen) <= RECENT_MS) || marks[raw.id] || !matchesFilters(raw, filters)) continue;
      const item = known ? deadlines.apply(raw, known) : raw;
      if (item.deadline && item.deadline < today) continue;
      if (prefs.near) {
        const point = locationFor(item, known);
        if (point ? distanceKm(prefs.near.lat, prefs.near.lng, point.lat, point.lng) > prefs.radius : !prefs.includeNoLoc) continue;
      }
      total++;
      if (!summary) items.push({ ...publicCampaign(item), favorite: Boolean(favorites[item.id]) });
    }
    items.sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
    json(res, 200, { day: today, configured: true, total, items: items.slice(0, PAGE_SIZE) });
  }

  // GET -> { preferences: saved | null } (null: never saved). PUT replaces them for the session's account only.
  // Optional X-Moa-Account header (GET and PUT): a tab that still believes it belongs to another account gets 409
  // instead of reading or writing the filters of the account that is now logged in. It never selects the account.
  async function preferencesRoute(req, res) {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'login_required', '로그인이 필요합니다.');
    const expected = req.headers['x-moa-account'];
    if (expected !== undefined && expected !== user.id) return fail(res, 409, 'account_changed', '다른 계정으로 로그인되어 있습니다.');
    if (req.method === 'GET') {
      const saved = await getPreferences(user.id);
      if (!saved) return json(res, 200, { preferences: null });
      const { updatedAt, ...rest } = saved;
      return json(res, 200, { preferences: rest, updatedAt: updatedAt || null });
    }
    if (req.method !== 'PUT') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    let body;
    try { body = JSON.parse(await readBody(req, 8192)); } catch { return fail(res, 400, 'bad_body', '요청 형식이 올바르지 않습니다.'); }
    const checked = validatePreferences(body?.preferences);
    if (checked.error) return fail(res, 400, 'bad_preferences', checked.error);
    const updatedAt = new Date(now()).toISOString();
    await savePreferences(user.id, { ...checked.preferences, updatedAt });
    json(res, 200, { preferences: checked.preferences, updatedAt });
  }

  async function favoriteRoute(req, res, url) {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'login_required', '로그인이 필요합니다.');
    const mine = await myFavorites(user.id);
    if (url.pathname === '/api/favorites') {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
      const myMarks = await userMarks(user.id);
      await addressContext();
      const knownDates = deadlines ? await deadlines.verifiedMap() : null;
      const items = Object.values(mine)
        .filter(item => myMarks[item.id]?.status !== 'excluded')
        .map(item => withAddress(item, knownDates))
        .map(item => ({ ...item, channels: cache?.byId.get(item.id)?.channels || item.channels || [], status: myMarks[item.id]?.status || null }))
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      return json(res, 200, { items });
    }
    if (url.pathname === '/api/favorites/manual') {
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
      let body;
      try { body = JSON.parse(await readBody(req, 4096)); } catch { return fail(res, 400, 'bad_body', '요청 형식이 올바르지 않습니다.'); }
      const checked = validateManual(body);
      if (checked.error) return fail(res, 400, 'bad_manual', checked.error);
      const item = { ...checked.item, id: `manual:${crypto.randomBytes(9).toString('base64url')}`, manual: true, savedAt: new Date(now()).toISOString() };
      if (!store) favorites[user.id] = { ...mine, [item.id]: item };
      await saveFavorites(user.id, item.id, item);
      return json(res, 201, { item });
    }
    let id;
    try { id = decodeURIComponent(url.pathname.slice('/api/favorites/'.length)); } catch { id = ''; }
    if (!/^[a-z0-9_-]{1,40}:[^\s/]{1,160}$/i.test(id)) return fail(res, 400, 'bad_id', '잘못된 공고 ID입니다.');
    if (req.method === 'DELETE') {
      if (mine[id]) { delete mine[id]; await saveFavorites(user.id, id, null); }
      res.writeHead(204); return res.end();
    }
    if (req.method !== 'PUT') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    if (mine[id]) { await addressContext(); return json(res, 200, { item: withAddress(mine[id], deadlines ? await deadlines.verifiedMap() : null) }); }
    let data;
    try { data = await campaigns(); } catch { return fail(res, 502, 'source_unavailable', '공고 데이터를 불러오지 못했습니다.'); }
    const raw = data.byId.get(id);
    if (!raw) return fail(res, 404, 'not_found', '공고를 찾을 수 없습니다.');
    const r = withAddress(raw, deadlines ? await deadlines.verifiedMap() : null);
    const item = {
      id: r.id, title: r.title, url: r.url, source: r.source, deadline: r.deadline,
      precision: r.precision, deadlineVerifiedAt: r.deadlineVerifiedAt, deadlineSource: r.deadlineSource, deadlineEvidence: r.deadlineEvidence,
      region_sido: r.region_sido, region_text: r.region_text, category: r.category, channels: r.channels, type: r.type || null,
      ...addressOf(r),
      savedAt: new Date(now()).toISOString()
    };
    if (!store) favorites[user.id] = { ...mine, [id]: item };
    await saveFavorites(user.id, id, item);
    json(res, 200, { item });
  }

  async function markRoute(req, res, url) {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'login_required', '로그인이 필요합니다.');
    if (req.headers['x-moa-account'] && req.headers['x-moa-account'] !== user.id) return fail(res, 409, 'account_changed', '다른 계정으로 로그인되어 있습니다.');
    const mine = await userMarks(user.id);
    if (url.pathname === '/api/marks') {
      if (req.method === 'GET') {
        const status = url.searchParams.get('status');
        await addressContext();
        const knownDates = deadlines ? await deadlines.verifiedMap() : null;
        const items = Object.entries(mine).map(([id, m]) => ({ ...m, id }))
          .filter(m => !status || m.status === status)
          .map(item => withAddress(item, knownDates))
          .sort((a, b) => b.at.localeCompare(a.at));
        return json(res, 200, { items });
      }
      if (req.method === 'DELETE') {
        // bulk restore: ?status=excluded clears only that status
        const status = url.searchParams.get('status');
        if (status !== 'excluded' && status !== 'applied') return fail(res, 400, 'bad_status', '상태 값이 올바르지 않습니다.');
        let removed = 0;
        for (const [id, m] of Object.entries(mine)) if (m.status === status) { delete mine[id]; await saveMarks(user.id, id, null); removed++; }
        return json(res, 200, { removed });
      }
      return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    }
    let id;
    try { id = decodeURIComponent(url.pathname.slice('/api/marks/'.length)); } catch { id = ''; }
    if (!/^[a-z0-9_-]{1,40}:[^\s/]{1,160}$/i.test(id)) return fail(res, 400, 'bad_id', '잘못된 공고 ID입니다.');
    if (req.method === 'DELETE') {
      if (mine[id]) { delete mine[id]; await saveMarks(user.id, id, null); }
      res.writeHead(204); return res.end();
    }
    if (req.method === 'PATCH') {
      let body;
      try { body = JSON.parse(await readBody(req, 1024)); } catch { return fail(res, 400, 'bad_body', '요청 형식이 올바르지 않습니다.'); }
      if (!APPLICATION_STAGES.includes(body?.stage) || !validScheduleDate(body.visitDate) || !validScheduleDate(body.reviewDue)) {
        return fail(res, 400, 'bad_application', '상태와 방문일·리뷰 마감일을 확인하세요.');
      }
      const fields = { stage: body.stage, visitDate: body.visitDate || null, reviewDue: body.reviewDue || null };
      let item;
      if (store?.updateApplication) {
        item = await store.updateApplication(user.id, id, fields);
      } else {
        const current = await userMarks(user.id);
        if (current[id]?.status === 'applied') {
          item = { ...current[id], ...fields };
          if (!store) marks[user.id] = { ...current, [id]: item };
          await saveMarks(user.id, id, item);
        }
      }
      if (!item) return fail(res, 404, 'not_found', '지원 기록을 찾을 수 없습니다.');
      return json(res, 200, { item: { ...item, id } });
    }
    if (req.method !== 'PUT') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
    let body;
    try { body = JSON.parse(await readBody(req, 1024)); } catch { return fail(res, 400, 'bad_body', '요청 형식이 올바르지 않습니다.'); }
    if (body?.status !== 'applied' && body?.status !== 'excluded') return fail(res, 400, 'bad_status', '상태 값이 올바르지 않습니다.');
    if (mine[id]?.status === 'applied' && body.status === 'applied') return json(res, 200, { item: { ...mine[id], id } });
    // snapshot so the excluded/applied lists still render after the source drops the campaign
    let snap = (await myFavorites(user.id))[id];
    if (!snap) {
      try { snap = (await campaigns()).byId.get(id); } catch { snap = null; }
    }
    if (!snap) return fail(res, 404, 'not_found', '공고를 찾을 수 없습니다.');
    await addressContext();
    snap = withAddress({ ...snap, id }, deadlines ? await deadlines.verifiedMap() : null);
    const mark = {
      status: body.status, at: new Date(now()).toISOString(),
      title: snap.title, url: snap.url, source: snap.source, deadline: snap.deadline,
      precision: snap.precision, deadlineVerifiedAt: snap.deadlineVerifiedAt, deadlineSource: snap.deadlineSource, deadlineEvidence: snap.deadlineEvidence,
      region_sido: snap.region_sido || null, region_text: snap.region_text || null, category: snap.category || '기타',
      channels: Array.isArray(snap.channels) ? snap.channels : [], type: snap.type || null,
      ...(snap.manual ? {} : addressOf(snap)),
      manual: Boolean(snap.manual)
    };
    if (!store) marks[user.id] = { ...mine, [id]: mark };
    await saveMarks(user.id, id, mark);
    json(res, 200, { item: { ...mark, id } });
  }

  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
        return fail(res, 403, 'bad_origin', '허용되지 않은 출처입니다.');
      }
      if (url.pathname === '/api/campaigns') return await listCampaigns(req, res, url);
      if (url.pathname === '/api/geo/resolve') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 50);
        const g = q ? resolver.resolve(null, q) || (places ? await places.anchor(q) : null) : null;
        return g ? json(res, 200, g) : fail(res, 404, 'place_not_found', '그 이름으로 찾은 지역이 없어요. 시·군·구나 동 이름으로 입력하세요.');
      }
      if (url.pathname === '/api/me') return await meRoute(req, res);
      if (url.pathname === '/api/events/open') return await openEventRoute(req, res);
      if (url.pathname === '/admin' || url.pathname === '/admin/') return await adminPage(req, res);
      if (url.pathname === '/api/admin/dashboard') return await adminDashboard(req, res, url);
      if (url.pathname === '/api/profile') return await profileRoute(req, res);
      if (url.pathname === '/api/preferences') return await preferencesRoute(req, res);
      if (url.pathname === '/api/digest') return await digestRoute(req, res, url);
      if (url.pathname === '/auth/kakao/login') return await login(req, res, url);
      if (url.pathname === '/auth/kakao/callback') return await callback(req, res, url);
      if (url.pathname === '/auth/logout') {
        if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '허용되지 않은 요청입니다.');
        return await logout(req, res);
      }
      if (url.pathname === '/api/favorites' || url.pathname.startsWith('/api/favorites/')) return await favoriteRoute(req, res, url);
      if (url.pathname === '/api/marks' || url.pathname.startsWith('/api/marks/')) return await markRoute(req, res, url);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await fs.promises.readFile(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      res.writeHead(404); res.end();
    } catch (err) {
      console.error('[server] request failed:', store ? (err.code || 'request error') : err.message);
      if (!res.headersSent) fail(res, 500, 'internal', '서버 오류가 발생했습니다.');
      else res.end();
    }
  }

  return { handler, authEnabled, campaigns, flush: () => Promise.all([writeChain, metrics.flush(), deadlines?.flush()]) };
}

function main() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const port = Number.parseInt(process.env.PORT, 10) || 8787;
  const hosts = (process.env.HOSTS || '127.0.0.1').split(',').map(h => h.trim());
  const bad = hosts.filter(h => FORBIDDEN_HOSTS.has(h));
  if (bad.length) {
    console.error(`[server] refusing public bind: ${bad.join(', ')}`);
    process.exit(1);
  }
  const places = process.env.KAKAO_REST_API_KEY && process.env.KAKAO_LOCAL !== '0'
    ? createPlaceLocator({ key: process.env.KAKAO_REST_API_KEY, cachePath: path.join(__dirname, 'data', 'kakao-places.json') })
    : null;
  const app = createApp({ places });
  console.log(`[server] precise store locations ${places ? 'on (Kakao Local)' : 'off'}`);
  console.log(`[server] kakao login ${app.authEnabled ? 'enabled' : 'disabled (KAKAO_REST_API_KEY / KAKAO_REDIRECT_URI not set)'}`);
  app.campaigns().catch(err => console.error('[server] warm-up failed:', err.message));
  for (const host of hosts) {
    const server = http.createServer(app.handler);
    let attempts = 0;
    server.on('error', err => {
      // listen() on this Windows host fails intermittently with EFAULT; retry briefly.
      if (err.code === 'EFAULT' && ++attempts < 10) return setTimeout(() => server.listen(port, host), 200);
      console.error(`[server] ${host}:${port} not bound: ${err.code || err.message}`);
    });
    server.listen(port, host, () => console.log(`[server] http://${host.includes(':') ? `[${host}]` : host}:${port}`));
  }
}

if (require.main === module) main();

module.exports = { createApp, safeReturn, normalize, validateManual, validateNickname, detectPlatform, parseAdminIds };
