'use strict';
// Request-bound lookups only: no filesystem writes or timers survive the function response.
const crypto = require('node:crypto');
const { distanceKm } = require('./geo.js');
const { extractName, choose } = require('./kakao-local.js');
function createServerlessPlaces({ store, key, fetch: fetchImpl = fetch, now = Date.now }) {
  let entries = {}, state = 'ok';
  let addressBackoff = {}, loadedAt = null, loading = null, cacheReady = false;
  const hash = s => crypto.createHash('sha256').update(s).digest('hex');
  const ttl = 7 * 86400000;
  const addressRetryMs = 5 * 60000;
  // Reading the existing cache never calls Kakao; other instances' changes become visible within a minute.
  async function loadCached() {
    if (loading) return loading;
    if (loadedAt !== null && now() - loadedAt < 60000) return entries;
    loading = (async () => {
      try {
        const [places, retries] = await Promise.all([store.list('place', ''), store.list('place-address-backoff', '')]);
        entries = places; addressBackoff = retries; cacheReady = true;
      } catch { cacheReady = false; state = 'disabled'; }
      finally { loadedAt = now(); loading = null; }
      return entries;
    })();
    return loading;
  }
  async function deferAddress(k) {
    const retry = { until: now() + addressRetryMs };
    addressBackoff[k] = retry;
    // Separate expiry: a failed address lookup must not replace or extend the seven-day coordinate hit.
    await store.set('place-address-backoff', '', k, retry, retry.until);
  }
  function keyFor(record, centroid) {
    const name = record.type === '방문형' && extractName(record.title, record.source);
    return name && centroid ? `${record.region_sido || ''}|${centroid.label || ''}|${name}` : null;
  }
  async function search(params) {
    // Across all serverless instances: at most 500 external requests per KST day.
    const day = new Date(now() + 9 * 3600000).toISOString().slice(0, 10);
    if (!await store.quota(`kakao:${day}`, 500, now() + 86400000)) { state = 'limited'; return []; }
    const u = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const response = await fetchImpl(u, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) { state = 'disabled'; return []; }
    state = 'ok';
    return (await response.json()).documents || [];
  }
  async function prepare(records, near) {
    await loadCached();
    if (!cacheReady) return;
    // At most one new place or old hit missing its address gets a lookup. Misses/ambiguous entries stay cached.
    const pending = records.filter(r => r.placeKey && r.lat !== null &&
      (!entries[r.placeKey] || (entries[r.placeKey].s === 'hit' && !entries[r.placeKey].address && !(addressBackoff[r.placeKey]?.until > now()))))
      .map(r => ({ r, d: distanceKm(near.lat, near.lng, r.lat, r.lng) }))
      .filter(x => x.d <= near.radius + 20).sort((a, b) => a.d - b.d);
    const r = pending[0]?.r;
    if (!r) return;
    const lease = hash(r.placeKey), token = crypto.randomUUID();
    if (!await store.acquire(`place:${lease}`, token, now() + 10000)) return;
    let existing = entries[r.placeKey];
    try {
      // A sibling instance may have filled this entry while our minute cache was still warm.
      if (store.get) {
        const latest = await store.get('place', '', r.placeKey);
        if (latest) { existing = latest; entries[r.placeKey] = latest; }
        const retry = await store.get('place-address-backoff', '', r.placeKey);
        if (retry?.until > now()) { addressBackoff[r.placeKey] = retry; return; }
      }
      if (existing && (existing.s !== 'hit' || existing.address)) return;
      const name = extractName(r.title, r.source), maxKm = r.geoLevel === 'dong' ? 6 : 20;
      const docs = await search({ query: name, x: r.lng, y: r.lat, radius: maxKm * 1000, size: 15 });
      const hit = choose(docs, { name, sido: r.region_sido, centre: r, maxKm });
      if (state !== 'ok') { if (existing) await deferAddress(r.placeKey); return; } // transient failures never replace a coordinate hit
      if (existing) {
        const sameName = String(hit.name || '').normalize('NFC').trim() === String(existing.name || '').normalize('NFC').trim();
        const samePlace = hit.status === 'hit' && sameName &&
          (!existing.url || !hit.url || existing.url === hit.url) && distanceKm(existing.lat, existing.lng, hit.lat, hit.lng) <= 0.1;
        if (!samePlace || !hit.address) { await deferAddress(r.placeKey); return; }
        const enriched = { ...existing, address: hit.address, roadAddress: hit.roadAddress, jibunAddress: hit.jibunAddress };
        // Preserve the original coordinate expiry and identity; only the validated address fields are new.
        const expires = Number(existing.t) + ttl;
        if (!(expires > now())) { await deferAddress(r.placeKey); return; }
        await store.set('place', '', r.placeKey, enriched, expires);
        entries[r.placeKey] = enriched;
        return;
      }
      const entry = { ...hit, s: hit.status, t: now() };
      await store.set('place', '', r.placeKey, entry, now() + ttl);
      entries[r.placeKey] = entry;
    } catch { state = 'disabled'; if (existing) { try { await deferAddress(r.placeKey); } catch {} } }
    finally { await store.release(`place:${lease}`, token); }
  }
  async function anchor(q) {
    const id = hash(q), existing = await store.get('anchor', '', id);
    if (existing) return existing;
    try {
      const d = (await search({ query: q, size: 1 }))[0];
      if (!d) return null;
      const lat = Number(d.y), lng = Number(d.x);
      if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) return null;
      const found = { lat, lng, level: 'place', label: String(d.place_name).slice(0, 40) };
      await store.set('anchor', '', id, found, now() + ttl);
      return found;
    } catch { state = 'disabled'; return null; }
  }
  return {
    keyFor, loadCached, prepare, anchor, enqueue() {},
    get: k => entries[k]?.s === 'hit' ? entries[k] : null,
    stats: () => ({ state, located: Object.values(entries).filter(x => x.s === 'hit').length, pending: 0 })
  };
}
module.exports = { createServerlessPlaces };
