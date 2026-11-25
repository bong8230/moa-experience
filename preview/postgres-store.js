'use strict';
// One row per session/state or per user's campaign. Writes never replace another user's data.
function createPostgresStore({ connectionString, pool: suppliedPool, now = Date.now } = {}) {
  const pool = suppliedPool || new (require('pg').Pool)({ connectionString, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
  pool.on?.('error', () => console.error('[database] idle connection failed'));
  async function get(scope, owner, key) {
    const r = await pool.query('SELECT value FROM moa_store WHERE scope=$1 AND owner=$2 AND key=$3 AND (expires IS NULL OR expires>$4)', [scope, owner, key, now()]);
    return r.rows[0]?.value || null;
  }
  async function set(scope, owner, key, value, expires = null) {
    await pool.query('INSERT INTO moa_store(scope,owner,key,value,expires) VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope,owner,key) DO UPDATE SET value=EXCLUDED.value,expires=EXCLUDED.expires', [scope, owner, key, JSON.stringify(value), expires]);
  }
  async function remove(scope, owner, key) {
    await pool.query('DELETE FROM moa_store WHERE scope=$1 AND owner=$2 AND key=$3', [scope, owner, key]);
  }
  async function updateApplication(owner, key, fields) {
    const result = await pool.query("UPDATE moa_store SET value=value || $3::jsonb WHERE scope='mark' AND owner=$1 AND key=$2 AND value->>'status'='applied' RETURNING value", [owner, key, JSON.stringify(fields)]);
    return result.rows[0]?.value || null;
  }
  async function take(scope, owner, key) {
    // DELETE RETURNING consumes OAuth state atomically across serverless instances.
    const r = await pool.query('DELETE FROM moa_store WHERE scope=$1 AND owner=$2 AND key=$3 AND (expires IS NULL OR expires>$4) RETURNING value', [scope, owner, key, now()]);
    return r.rows[0]?.value || null;
  }
  async function list(scope, owner) {
    const r = await pool.query('SELECT key,value FROM moa_store WHERE scope=$1 AND owner=$2 AND (expires IS NULL OR expires>$3)', [scope, owner, now()]);
    return Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  }
  async function acquire(key, token, expires) {
    const r = await pool.query("INSERT INTO moa_store(scope,owner,key,value,expires) VALUES('lease','',$1,$2,$3) ON CONFLICT(scope,owner,key) DO UPDATE SET value=EXCLUDED.value,expires=EXCLUDED.expires WHERE moa_store.expires<$4 RETURNING key", [key, JSON.stringify(token), expires, now()]);
    return Boolean(r.rows.length);
  }
  async function release(key, token) {
    await pool.query("DELETE FROM moa_store WHERE scope='lease' AND owner='' AND key=$1 AND value=$2::jsonb", [key, JSON.stringify(token)]);
  }
  async function quota(key, limit, expires) {
    const r = await pool.query("INSERT INTO moa_store(scope,owner,key,value,expires) VALUES('quota','',$1,'1'::jsonb,$2) ON CONFLICT(scope,owner,key) DO UPDATE SET value=CASE WHEN moa_store.expires<=$3 THEN '1'::jsonb ELSE to_jsonb((moa_store.value::text)::int+1) END,expires=EXCLUDED.expires WHERE moa_store.expires<=$3 OR (moa_store.value::text)::int<$4 RETURNING key", [key, expires, now(), limit]);
    return Boolean(r.rows.length);
  }
  // --- metrics helpers (admin dashboard). Counters are jsonb integers updated in one statement each. ---
  async function setDefault(scope, owner, key, value) {
    // first writer wins; returns the stored value
    const r = await pool.query('INSERT INTO moa_store(scope,owner,key,value) VALUES($1,$2,$3,$4) ON CONFLICT(scope,owner,key) DO UPDATE SET value=moa_store.value RETURNING value', [scope, owner, key, JSON.stringify(value)]);
    return r.rows[0].value;
  }
  async function increment(scope, owner, key) {
    const r = await pool.query("INSERT INTO moa_store(scope,owner,key,value) VALUES($1,$2,$3,'1'::jsonb) ON CONFLICT(scope,owner,key) DO UPDATE SET value=to_jsonb((moa_store.value::text)::bigint+1) RETURNING value", [scope, owner, key]);
    return Number(r.rows[0].value);
  }
  async function sumByKey(scope, ownerFrom) {
    // owner holds a KST date (YYYY-MM-DD) for daily counters, so >= selects a date range
    const r = await pool.query('SELECT key, SUM((value::text)::bigint)::bigint AS n FROM moa_store WHERE scope=$1 AND owner>=$2 GROUP BY key', [scope, ownerFrom]);
    return Object.fromEntries(r.rows.map(x => [x.key, Number(x.n)]));
  }
  async function listScope(scope) {
    const r = await pool.query('SELECT owner,key,value FROM moa_store WHERE scope=$1 AND (expires IS NULL OR expires>$2)', [scope, now()]);
    return r.rows;
  }
  async function visit(userId, at, gapMs, day, kakaoNickname) {
    // One statement: update the visitor row under its row lock, and bump the daily counter only when
    // this request starts a new visit (n=1). Concurrent requests serialize on the row, so each visit counts once.
    const r = await pool.query(`WITH v AS (
      INSERT INTO moa_store(scope,owner,key,value) VALUES('visitor','',$1,jsonb_build_object('first',$2::bigint,'last',$2::bigint,'count',1,'n',1,'kakaoNickname',$5::text))
      ON CONFLICT(scope,owner,key) DO UPDATE SET value=moa_store.value || jsonb_build_object(
        'last', GREATEST((moa_store.value->>'last')::bigint, $2::bigint),
        'kakaoNickname', $5::text,
        'n', CASE WHEN $2::bigint-(moa_store.value->>'last')::bigint >= $3::bigint THEN 1 ELSE 0 END,
        'count', (moa_store.value->>'count')::bigint + CASE WHEN $2::bigint-(moa_store.value->>'last')::bigint >= $3::bigint THEN 1 ELSE 0 END)
      RETURNING value)
    INSERT INTO moa_store(scope,owner,key,value) SELECT 'visitday',$4,$1,'1'::jsonb FROM v WHERE (v.value->>'n')::int=1
    ON CONFLICT(scope,owner,key) DO UPDATE SET value=to_jsonb((moa_store.value::text)::bigint+1)
    RETURNING key`, [userId, at, gapMs, day, kakaoNickname]);
    return r.rows.length > 0;
  }
  async function prune() { await pool.query('DELETE FROM moa_store WHERE expires IS NOT NULL AND expires<$1', [now()]); }
  return { get, set, remove, updateApplication, take, list, acquire, release, quota, prune, setDefault, increment, sumByKey, listScope, visit, close: () => pool.end() };
}
module.exports = { createPostgresStore };
