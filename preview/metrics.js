'use strict';
// Usage metrics for the owner dashboard.
//
// What is recorded (nothing else):
//   - visitor  : per logged-in account id -> { first, last, count, kakaoNickname } (epoch ms)
//   - visitday : per KST date and account id -> number of visits that day
//   - openday  : per KST date and campaign id -> number of "원본 열기" clicks that day
//   - openmeta : per campaign id -> server-side snapshot { title, source, url } from the collected source
//   - meta/metricsStart : when collection began. Nothing before it can be reconstructed.
// No IP address, location, token, session id or e-mail is stored or returned.
//
// A "visit" is a logged-in page load (/api/me) at least VISIT_GAP_MS after that account's previous one.
// With a Postgres store the counters are updated atomically in SQL (postgres-store.js). Without one they
// live in a local JSON file; updates are synchronous in this process, then written with tmp+rename.
const fs = require('node:fs');
const path = require('node:path');

const VISIT_GAP_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const TOP_CAMPAIGNS = 50;

const kstDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

function fileBackend(filePath) {
  const rows = new Map(); // `${scope}\u0000${owner}\u0000${key}` -> { scope, owner, key, value }
  try {
    for (const [scope, owner, key, value] of JSON.parse(fs.readFileSync(filePath, 'utf8')).rows || []) rows.set(`${scope}\u0000${owner}\u0000${key}`, { scope, owner, key, value });
  } catch { /* first run */ }
  const id = (scope, owner, key) => `${scope}\u0000${owner}\u0000${key}`;
  let chain = Promise.resolve();
  function save() {
    const data = JSON.stringify({ rows: [...rows.values()].map(r => [r.scope, r.owner, r.key, r.value]) });
    chain = chain.then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, filePath);
    });
    return chain;
  }
  const put = (scope, owner, key, value) => rows.set(id(scope, owner, key), { scope, owner, key, value });
  return {
    async setDefault(scope, owner, key, value) {
      const hit = rows.get(id(scope, owner, key));
      if (hit) return hit.value;
      put(scope, owner, key, value); await save(); return value;
    },
    async increment(scope, owner, key) {
      const n = (rows.get(id(scope, owner, key))?.value || 0) + 1;
      put(scope, owner, key, n); await save(); return n;
    },
    async set(scope, owner, key, value) { put(scope, owner, key, value); await save(); },
    async sumByKey(scope, ownerFrom) {
      const out = {};
      for (const r of rows.values()) if (r.scope === scope && r.owner >= ownerFrom) out[r.key] = (out[r.key] || 0) + r.value;
      return out;
    },
    async listScope(scope) { return [...rows.values()].filter(r => r.scope === scope).map(({ owner, key, value }) => ({ owner, key, value })); },
    async visit(userId, at, gapMs, day, kakaoNickname) {
      const prev = rows.get(id('visitor', '', userId))?.value;
      const counted = !prev || at - prev.last >= gapMs;
      put('visitor', '', userId, prev
        ? { ...prev, last: Math.max(prev.last, at), kakaoNickname, count: prev.count + (counted ? 1 : 0) }
        : { first: at, last: at, count: 1, kakaoNickname });
      if (counted) put('visitday', day, userId, (rows.get(id('visitday', day, userId))?.value || 0) + 1);
      await save();
      return counted;
    },
    flush: () => chain
  };
}

function createMetrics({ store, filePath, now = Date.now }) {
  const db = store || fileBackend(filePath);
  let startAt = null;
  async function start() {
    if (startAt === null) startAt = Number(await db.setDefault('meta', '', 'metricsStart', now()));
    return startAt;
  }

  async function recordVisit(user) {
    await start();
    const t = now();
    return db.visit(user.id, t, VISIT_GAP_MS, kstDate(t), user.kakaoNickname || null);
  }

  // campaign is the server's own record (never client input); only http(s) links are kept
  async function recordOpen(campaign) {
    await start();
    const t = now();
    let url = null;
    try { const u = new URL(campaign.url); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href.slice(0, 500); } catch { url = null; }
    await db.increment('openday', kstDate(t), campaign.id);
    await db.set('openmeta', '', campaign.id, {
      title: String(campaign.title || '').slice(0, 200), source: String(campaign.source || '').slice(0, 40), url, lastAt: t
    });
  }

  // days: 7 or 30 (KST calendar days including today). nicknames: Map(accountId -> saved app nickname)
  async function dashboard(days, { nicknames = new Map(), adminIds = new Set() } = {}) {
    const since = await start();
    const t = now();
    const today = kstDate(t);
    const from = kstDate(t - (days - 1) * DAY_MS);
    const fromMs = Date.parse(`${from}T00:00:00+09:00`);
    const [visitorRows, visitsIn, opensIn, opensAll, metaRows] = await Promise.all([
      db.listScope('visitor'), db.sumByKey('visitday', from), db.sumByKey('openday', from), db.sumByKey('openday', ''), db.listScope('openmeta')
    ]);
    const visitors = new Map(visitorRows.map(r => [r.key, r.value]));
    const ids = new Set([...visitors.keys(), ...nicknames.keys()]);
    const iso = ms => (ms ? new Date(Number(ms)).toISOString() : null);
    const users = [...ids].map(id => {
      const v = visitors.get(id);
      return {
        nickname: nicknames.get(id) || v?.kakaoNickname || '카카오 사용자',
        nicknameSet: nicknames.has(id),
        admin: adminIds.has(id),
        firstVisit: iso(v?.first), lastVisit: iso(v?.last),
        visits: Number(v?.count || 0), visitsInRange: Number(visitsIn[id] || 0)
      };
    }).sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || '') || a.nickname.localeCompare(b.nickname, 'ko'));
    const meta = new Map(metaRows.map(r => [r.key, r.value]));
    const campaigns = Object.entries(opensIn).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_CAMPAIGNS)
      .map(([id, opens]) => {
        const m = meta.get(id) || {};
        return { id, title: m.title || '(제목 없음)', source: m.source || '', url: m.url || null, opens, opensAllTime: Number(opensAll[id] || opens) };
      });
    const sum = o => Object.values(o).reduce((a, n) => a + Number(n), 0);
    return {
      days, range: { from, to: today }, collectingSince: new Date(since).toISOString(), generatedAt: new Date(t).toISOString(),
      definitions: {
        visit: '로그인한 사용자가 앱을 연 횟수. 같은 계정이 30분 안에 다시 열면 한 번으로 셉니다.',
        open: "공고의 '원본 열기'를 누른 횟수. 목록에 보이기만 한 것은 세지 않습니다."
      },
      totals: {
        registeredUsers: users.length,
        activeUsers: users.filter(u => u.visitsInRange > 0).length,
        newUsers: [...visitors.values()].filter(v => Number(v.first) >= fromMs).length,
        visits: sum(visitsIn),
        opens: sum(opensIn),
        openedCampaigns: Object.values(opensIn).filter(n => n > 0).length
      },
      users, campaigns
    };
  }

  return { start, recordVisit, recordOpen, dashboard, flush: () => db.flush?.() };
}

module.exports = { createMetrics, kstDate, VISIT_GAP_MS };
