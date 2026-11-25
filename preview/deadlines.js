'use strict';
// Verified application deadlines and visit addresses from the original campaign page.
//
// Deadlines: 디너의여왕 (dinnerqueen) only. Its detail page shows the application period twice:
//   - the info table:      신청 기간 / 발표 날짜 / 리뷰 기간  ->  "26.11.09 – 26.11.15" / "26.11.16" / ...
//   - the calendar script: { title: '신청', start: '2026-11-09', end: '2026-11-16' }  (end is exclusive)
// A deadline is accepted only when both agree (table end == script end - 1 day, same start) and the
// dates are real calendar dates. It is a date only: no time of day is known, none is invented.
// Anything else (HTTP error, redirect, changed HTML, mismatch, robots disallow) keeps the source's estimate.
//
// Requests: canonical https://dinnerqueen.net/taste/<numeric id> only, no redirects, short timeout,
// capped body, robots.txt honoured per path, at most 1 request per second across instances, a daily cap,
// a per-campaign lease against duplicate fetches. Raw HTML is never stored; only the short period text.
//
// Visit addresses (addresses.js) come from the same single page fetch: 디너의여왕 (any campaign; product
// campaigns simply have no visit section) and 강남맛집 (visit campaigns only, /cp/?id=<n>, robots checked on
// path + query). An entry stored before addresses existed (no `place`) is fetched once more to fill it in.
// reviewnote is never fetched (its robots.txt disallows /campaigns/).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseDinnerqueenPlace, parseGangnamPlace, placeFields } = require('./addresses.js');

// one page per campaign; each host has its own request spacing, daily cap and robots.txt
const SITES = {
  dinnerqueen: {
    host: 'dinnerqueen.net', id: /^dinnerqueen:(\d{1,12})$/, path: n => `/taste/${n}`, deadline: true, parsePlace: parseDinnerqueenPlace,
    rateKey: 'deadline-rate', dayKey: day => `deadline-day:${day}`
  },
  gangnammat: {
    host: 'gangnam-review.net', id: /^gangnammat:(\d{1,12})$/, path: n => `/cp/?id=${n}`, deadline: false, parsePlace: parseGangnamPlace,
    visitOnly: true, rateKey: 'deadline-rate:gangnam-review.net', dayKey: day => `deadline-day:gangnam-review.net:${day}`
  }
};
const USER_AGENT = 'MoaExperienceBot/1.0 (+deadline check; low volume)';
const TTL = { verified: 6 * 3600e3, mismatch: 6 * 3600e3, unparsed: 6 * 3600e3, checked: 6 * 3600e3, error: 30 * 60e3 };
const ROBOTS_TTL = 24 * 3600e3;
const BODY_CAP = 1024 * 1024;
const ROBOTS_CAP = 64 * 1024;
const DEFAULT_BUDGET_MS = 2500;
const MIN_FETCH_MS = 300;
const SLOT_POLL_MS = 250;
const TIMEOUT_MS = 2000;
const DAY_MS = 86400e3;

const kstDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

function validDate(y, m, d) {
  if (!(y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
const isoDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? validDate(+m[1], +m[2], +m[3]) : null; };
const minusDay = iso => new Date(Date.parse(iso + 'T00:00:00Z') - DAY_MS).toISOString().slice(0, 10);

// -> { start, end, evidence } | { error: 'unparsed' | 'mismatch' }
function parseDinnerqueen(html) {
  if (typeof html !== 'string' || !html) return { error: 'unparsed' };
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  // label row then value row, in that order; the page repeats the block (mobile/desktop), all copies must agree
  const tableRe = /신청 기간 발표 날짜 리뷰 기간 (\d{2})\.(\d{2})\.(\d{2}) ?[–—~-] ?(\d{2})\.(\d{2})\.(\d{2}) (\d{2})\.(\d{2})\.(\d{2})/g;
  const tables = new Set();
  let announce = null;
  for (const m of text.matchAll(tableRe)) {
    const start = validDate(2000 + +m[1], +m[2], +m[3]);
    const end = validDate(2000 + +m[4], +m[5], +m[6]);
    const ann = validDate(2000 + +m[7], +m[8], +m[9]);
    if (!start || !end || !ann) return { error: 'unparsed' };
    tables.add(`${start}|${end}|${m[1]}.${m[2]}.${m[3]} – ${m[4]}.${m[5]}.${m[6]}`);
    announce = ann;
  }
  const scriptRe = /title:\s*'신청'\s*,\s*start:\s*'([^']{10})'\s*,\s*end:\s*'([^']{10})'/g;
  const scripts = new Set();
  for (const m of html.matchAll(scriptRe)) {
    const s = isoDate(m[1]), e = isoDate(m[2]);
    if (!s || !e) return { error: 'unparsed' };
    scripts.add(`${s}|${e}`);
  }
  if (tables.size === 0 || scripts.size === 0) return { error: 'unparsed' };
  if (tables.size > 1 || scripts.size > 1) return { error: 'mismatch' };
  const [start, end, evidence] = [...tables][0].split('|');
  const [sStart, sEndExclusive] = [...scripts][0].split('|');
  if (sStart !== start || minusDay(sEndExclusive) !== end) return { error: 'mismatch' };
  if (start > end || announce < end) return { error: 'mismatch' };
  return { start, end, evidence: `신청 기간 ${evidence}` };
}

// minimal robots.txt check for our user agent (falls back to the * group); longest matching rule wins
function robotsAllows(robots, pathName) {
  const groups = [];
  let current = null, lastWasAgent = false;
  for (const raw of String(robots).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && 'moaexperiencebot'.includes(a)));
  const chosen = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  let best = null;
  for (const rule of chosen.flatMap(g => g.rules)) {
    if (!rule.pattern) continue; // "Disallow:" with no value allows everything
    const re = new RegExp('^' + rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathName) && (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow))) best = rule;
  }
  return best ? best.allow : true;
}

async function readCapped(response, cap) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) { try { await reader.cancel(); } catch {} throw new Error('body too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > cap) throw new Error('body too large');
  return text;
}

// now: data clock (timestamps, TTLs, slots). monotonic/sleep: the request budget (injectable for tests).
function createDeadlineVerifier({ store, filePath, fetch: fetchImpl, now = Date.now, dailyCap = 500, intervalMs = 1000, timeoutMs = TIMEOUT_MS,
  monotonic = () => performance.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} }) {
  // ---- persistence: DB scope 'deadline' (shared) or a local JSON file ----
  let fileData = null, chain = Promise.resolve();
  if (!store) { try { fileData = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {}; } catch { fileData = {}; } }
  const saveFile = () => {
    const data = JSON.stringify(fileData);
    chain = chain.then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, filePath);
    }).catch(err => log('[deadlines] cache not written: ' + err.code));
    return chain;
  };
  async function getEntry(key) {
    if (store) return store.get('deadline', '', key);
    const v = fileData[key];
    return v && v.expires > now() ? v : null;
  }
  async function putEntry(key, value) {
    if (store) return store.set('deadline', '', key, value, value.expires);
    fileData[key] = value;
    return saveFile();
  }
  async function allEntries() {
    if (store) return (await store.listScope('deadline')).map(r => [r.key, r.value]);
    return Object.entries(fileData).filter(([, v]) => v && v.expires > now());
  }

  // ---- in-memory view of verified deadlines / found addresses, refreshed at most once a minute ----
  let overlay = new Map(), overlayAt = 0, overlayLoading = null;
  async function verifiedMap() {
    if (now() - overlayAt < 60e3) return overlay;
    overlayLoading ||= (async () => {
      try {
        const next = new Map();
        for (const [key, v] of await allEntries()) {
          if (key.startsWith('robots:') || !v) continue;
          if (useful(v)) next.set(key, v);
          // a fresh, complete result with nothing usable is not picked again until it expires (cold instances too)
          else if (complete(v) && v.expires > now()) notVerified.set(key, v.expires);
        }
        overlay = next; overlayAt = now();
      } catch (err) { log('[deadlines] cache read failed: ' + (err.code || err.message)); }
      finally { overlayLoading = null; }
      return overlay;
    })();
    return overlayLoading;
  }

  // ---- request budget: global spacing and daily cap (shared through the DB), per-campaign lease ----
  const local = {}; // host -> { last, day, count }
  const localLeases = new Set();
  // -> 'ok' | 'rate' (try again shortly) | 'cap' (no more today)
  async function takeSlot(site) {
    const t = now();
    if (store) {
      if (!await store.acquire(site.rateKey, 'r', t + intervalMs)) return 'rate';
      return (await store.quota(site.dayKey(kstDate(t)), dailyCap, t + 2 * DAY_MS)) ? 'ok' : 'cap';
    }
    const l = local[site.host] ||= { last: 0, day: '', count: 0 };
    if (t - l.last < intervalMs) return 'rate';
    const day = kstDate(t);
    if (day !== l.day) { l.day = day; l.count = 0; }
    if (l.count >= dailyCap) return 'cap';
    l.last = t; l.count++;
    return 'ok';
  }
  // waits for the next slot while the request budget allows (never past deadlineAt)
  async function waitSlot(site, deadlineAt) {
    for (;;) {
      const slot = await takeSlot(site);
      if (slot !== 'rate') return slot;
      const left = deadlineAt - monotonic() - MIN_FETCH_MS;
      if (left <= 0) return 'budget';
      await sleep(Math.min(SLOT_POLL_MS, left));
    }
  }
  async function lease(id) {
    if (store) {
      const token = crypto.randomBytes(8).toString('hex');
      return (await store.acquire(`deadline:${id}`, token, now() + 20e3)) ? () => store.release(`deadline:${id}`, token) : null;
    }
    if (localLeases.has(id)) return null;
    localLeases.add(id);
    return async () => localLeases.delete(id);
  }

  // the fetch never outlives the request budget
  async function get(url, deadlineAt, cap) {
    const ms = Math.floor(Math.min(timeoutMs, deadlineAt - monotonic()));
    if (ms < MIN_FETCH_MS) throw new Error('no time left');
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(ms), headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain' } });
    return { status: response.status, type: response.headers?.get?.('content-type') || '', body: response.status === 200 ? await readCapped(response, cap) : '' };
  }

  // robots.txt: the rules text is cached (never HTML) and every candidate path is checked against it.
  // An HTML/challenge answer or a server error means the policy is unknown: nothing is fetched.
  const robotsMemo = {};
  async function robotsPolicy(site, deadlineAt) {
    const key = `robots:${site.host}`;
    if (robotsMemo[key] && robotsMemo[key].expires > now()) return robotsMemo[key];
    const cached = await getEntry(key);
    if (cached) { robotsMemo[key] = cached; return cached; }
    const slot = await waitSlot(site, deadlineAt);
    if (slot !== 'ok') return { status: 'deferred', reason: slot };
    const fresh = await getEntry(key); // another instance may have fetched it meanwhile
    if (fresh) { robotsMemo[key] = fresh; return fresh; }
    let entry;
    try {
      const r = await get(`https://${site.host}/robots.txt`, deadlineAt, ROBOTS_CAP);
      const looksHtml = /html/i.test(r.type) || /<(?:!doctype|html|head|body|script)\b/i.test(r.body);
      if (r.status === 404 || r.status === 410) entry = { status: 'ok', rules: '' }; // no robots.txt: no restrictions
      else if (r.status === 200 && !looksHtml) entry = { status: 'ok', rules: r.body };
      else entry = { status: 'unknown', reason: `robots HTTP ${r.status}${looksHtml ? ' html' : ''}` };
    } catch (err) {
      entry = { status: 'unknown', reason: 'robots ' + err.message };
    }
    entry.expires = now() + (entry.status === 'ok' ? ROBOTS_TTL : TTL.error);
    if (entry.status !== 'ok') log(`[deadlines] robots policy unknown for ${site.host}: ${entry.reason}`);
    robotsMemo[key] = entry;
    await putEntry(key, entry);
    return entry;
  }

  // ids whose last check gave nothing usable (mismatch/unparsed/error/robots) are skipped until that result expires
  const notVerified = new Map();
  const siteOf = r => r && typeof r.id === 'string' && SITES[r.source] && SITES[r.source].id.test(r.id) ? SITES[r.source] : null;
  // the page is fetched for: dinnerqueen campaigns without an exact source deadline (date check) or of visit type
  // (address, even when the source date is already exact); 강남맛집 visit campaigns (address only)
  const supports = r => {
    const site = siteOf(r);
    if (!site) return false;
    return r.type === '방문형' || (site.deadline && r.precision !== 'exact');
  };
  const canonicalPath = (site, id) => site.path(site.id.exec(id)[1]);
  const deferred = reason => ({ status: 'deferred', reason });
  // an entry from before addresses were read has no `place`: it is fetched once more
  const complete = entry => Boolean(entry) && entry.place !== undefined;
  function useful(v) { return Boolean(v) && (v.status === 'verified' || v.place?.status === 'found'); }
  const remember = (id, entry) => {
    if (useful(entry)) { overlay.set(id, entry); notVerified.delete(id); }
    else { overlay.delete(id); notVerified.set(id, entry.expires); }
    return entry;
  };

  // one campaign within the request budget -> stored entry, or { status: 'deferred', reason } (nothing stored)
  async function verifyOne(record, { deadlineAt = monotonic() + DEFAULT_BUDGET_MS } = {}) {
    if (!supports(record)) return deferred('unsupported');
    const site = siteOf(record);
    const cached = await getEntry(record.id);
    if (complete(cached)) return remember(record.id, cached);
    const policy = await robotsPolicy(site, deadlineAt);
    if (policy.status === 'deferred') return deferred(policy.reason);
    if (policy.status !== 'ok') return deferred('robots_unknown');
    const pathName = canonicalPath(site, record.id);
    if (!robotsAllows(policy.rules, pathName)) { notVerified.set(record.id, policy.expires); return deferred('robots_disallow'); }
    const release = await lease(record.id);
    if (!release) return deferred('leased');
    try {
      const again = await getEntry(record.id); // another instance may have finished while we waited for the lease
      if (complete(again)) return remember(record.id, again);
      const slot = await waitSlot(site, deadlineAt);
      if (slot !== 'ok') return deferred(slot);
      const url = `https://${site.host}${pathName}`;
      const checkedAt = new Date(now()).toISOString();
      let entry;
      try {
        const r = await get(url, deadlineAt, BODY_CAP);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        if (!/text\/html/i.test(r.type)) throw new Error('not html');
        // only the parsed results are kept, never the page
        const p = site.parsePlace(r.body);
        const place = p.status === 'found'
          ? { status: 'found', address: p.address, sido: p.sido, ...(p.lat != null ? { lat: p.lat, lng: p.lng } : {}), ...(p.mapUrl ? { mapUrl: p.mapUrl } : {}) }
          : { status: p.status };
        if (!site.deadline) entry = { status: 'checked', place, checkedAt, url };
        else {
          const parsed = parseDinnerqueen(r.body);
          const previous = again || cached;
          entry = parsed.error
            ? (previous?.status === 'verified'
              ? { ...previous, place }
              : { status: parsed.error, place, checkedAt, url })
            : { status: 'verified', deadline: parsed.end, start: parsed.start, evidence: parsed.evidence, place, checkedAt, url };
        }
      } catch (err) {
        // filling in the address of an older entry failed: keep its (still valid) deadline result and expiry,
        // record only that the address could not be read
        const previous = again || cached;
        entry = previous ? { ...previous, place: { status: 'error' } } : { status: 'error', place: { status: 'error' }, checkedAt, url };
        log(`[deadlines] ${record.id} not checked: ${err.message}`);
      }
      if (entry.expires === undefined) entry.expires = now() + TTL[entry.status];
      await putEntry(record.id, entry);
      return remember(record.id, entry);
    } finally { await release(); }
  }

  // Up to `max` unverified supported records, in the given order (visible page first), one after another,
  // all inside this request: nothing keeps running after it returns (serverless may freeze).
  async function verifySome(records, { max = 3, budgetMs = DEFAULT_BUDGET_MS } = {}) {
    const deadlineAt = monotonic() + budgetMs;
    const known = await verifiedMap();
    const picks = [];
    for (const r of records) {
      if (picks.length >= max) break;
      if (supports(r) && !complete(known.get(r.id)) && !(notVerified.get(r.id) > now()) && !picks.some(p => p.id === r.id)) picks.push(r);
    }
    const result = { candidates: picks.length, verified: 0, addresses: 0, checked: 0, deferred: null };
    const blocked = new Set(); // hosts at their daily cap or with an unknown robots policy: skipped for this run
    for (const r of picks) {
      if (deadlineAt - monotonic() < MIN_FETCH_MS) { result.deferred = 'budget'; break; }
      const host = siteOf(r).host;
      if (blocked.has(host)) continue;
      let e;
      try { e = await verifyOne(r, { deadlineAt }); }
      catch (err) { log('[deadlines] verify failed: ' + (err.code || err.message)); result.deferred = 'store'; break; }
      if (e.status === 'deferred') {
        result.deferred = e.reason;
        if (e.reason === 'leased' || e.reason === 'robots_disallow') continue;
        if (e.reason === 'cap' || e.reason === 'robots_unknown') { blocked.add(host); continue; } // other hosts may still go
        break; // budget/rate: the rest would wait too
      }
      result.checked++;
      if (e.status === 'verified') result.verified++;
      if (e.place?.status === 'found') result.addresses++;
    }
    return result;
  }

  // record with a verified deadline and/or the original page's visit address applied (or the record unchanged).
  // Only visit campaigns get an address (placeFields): a seller's address is not a place to visit.
  function apply(record, map) {
    const v = map.get(record.id);
    const site = siteOf(record);
    if (!v || !site || record.manual) return record;
    let out = record;
    if (v.status === 'verified' && site.deadline && record.precision !== 'exact') {
      out = { ...out, deadline: v.deadline, precision: 'exact_date', deadlineVerifiedAt: v.checkedAt, deadlineSource: v.url, deadlineEvidence: v.evidence };
    }
    const place = placeFields(v, record);
    if (place) out = { ...out, ...place };
    return out;
  }

  return { supports, verifiedMap, verifySome, verifyOne, apply, flush: () => chain };
}

module.exports = { createDeadlineVerifier, parseDinnerqueen, robotsAllows, validDate };
