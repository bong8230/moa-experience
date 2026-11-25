'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerlessPlaces } = require('./serverless-places.js');
test('serverless place lookup recovers after a transient failure without caching the failure', async () => {
  const entries = {};
  let calls = 0;
  const store = {
    list: async () => ({ ...entries }), quota: async () => true, acquire: async () => true, release: async () => {},
    set: async (scope, owner, key, value) => { entries[key] = value; }
  };
  const places = createServerlessPlaces({ store, key: 'test', fetch: async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ documents: [{ place_name: '회복카페', address_name: '서울 성동구', y: '37.54', x: '127.05', place_url: 'https://place.map.kakao.com/123' }] }) };
  } });
  const r = { type: '방문형', title: '[서울 성수] 회복카페', source: 'reviewnote', region_sido: '서울', lat: 37.54, lng: 127.05, geoLevel: 'dong', geoLabel: '서울 성수' };
  r.placeKey = places.keyFor(r, { label: r.geoLabel });
  const near = { lat: 37.54, lng: 127.05, radius: 5 };
  await places.prepare([r], near);
  assert.equal(places.stats().state, 'disabled');
  assert.equal(Object.keys(entries).length, 0);
  await places.prepare([r], near);
  assert.equal(places.stats().state, 'ok');
  assert.equal(places.get(r.placeKey).name, '회복카페');
  await places.prepare([r], near);
  assert.equal(calls, 2, 'a cached hit does not trigger another external request');
});

function backfillHarness({ documents, status = 200 } = {}) {
  let clock = 1000000, calls = 0, placeReads = 0;
  const values = { place:{}, 'place-address-backoff':{} }, writes = [];
  const store = {
    list:async scope => { if(scope==='place') placeReads++; return {...(values[scope] || {})}; },
    get:async (scope,owner,key) => values[scope]?.[key] || null,
    quota:async () => true, acquire:async () => true, release:async () => {},
    set:async (scope,owner,key,value,expires) => { (values[scope] ||= {})[key]=value; writes.push({scope,key,value,expires}); }
  };
  const row = {type:'방문형',title:'[서울 성수] 기존카페',source:'reviewnote',region_sido:'서울',lat:37.54,lng:127.05,geoLevel:'dong',geoLabel:'서울 성수'};
  const doc = {place_name:'기존카페',address_name:'서울 성동구 성수동 1',road_address_name:'서울 성동구 성수로 1',y:'37.54',x:'127.05',place_url:'https://place.map.kakao.com/77'};
  const places=createServerlessPlaces({store,key:'test',now:()=>clock,fetch:async()=>{calls++;return {ok:status===200,status,json:async()=>({documents:documents || [doc]})};}});
  row.placeKey=places.keyFor(row,{label:row.geoLabel});
  const old = {s:'hit',t:clock-1000,lat:37.54,lng:127.05,name:'기존카페',url:'https://place.map.kakao.com/77'};
  values.place[row.placeKey]=old;
  return {places,row,old,values,writes,near:{lat:37.54,lng:127.05,radius:5},store,
    advance:ms=>{clock+=ms;},calls:()=>calls,reads:()=>placeReads};
}

test('loadCached is a cold single flight, reuses a minute cache and never calls Kakao',async()=>{
  const h=backfillHarness();
  await Promise.all([h.places.loadCached(),h.places.loadCached(),h.places.loadCached()]);
  assert.equal(h.reads(),1);
  assert.deepEqual(h.places.get(h.row.placeKey),h.old);
  await h.places.loadCached(); assert.equal(h.reads(),1);
  h.advance(60000); await h.places.loadCached(); assert.equal(h.reads(),2);
  assert.equal(h.calls(),0);
});

test('prepare lazily backfills one old hit, preserves coordinates and original expiry, and reuses loaded data',async()=>{
  const h=backfillHarness();
  h.values.place.other={s:'miss',t:1000000};
  const other={...h.row,placeKey:'other'};
  await h.places.loadCached();
  await h.places.prepare([h.row,other],h.near);
  assert.equal(h.calls(),1);
  assert.equal(h.reads(),1);
  const hit=h.places.get(h.row.placeKey);
  assert.equal(hit.address,'서울 성동구 성수로 1');
  for(const k of ['lat','lng','name','url','t']) assert.equal(hit[k],h.old[k]);
  assert.equal(h.writes.find(w=>w.scope==='place').expires,h.old.t+7*86400000);
  await h.places.prepare([h.row,other],h.near);
  assert.equal(h.calls(),1,'existing address and negative entries require no more external requests');
});

test('old-hit failure keeps its seven-day row and shares short retry backoff across cold instances',async()=>{
  const h=backfillHarness({status:503});
  await h.places.prepare([h.row],h.near);
  assert.deepEqual(h.values.place[h.row.placeKey],h.old);
  assert.equal(h.writes.filter(w=>w.scope==='place').length,0);
  await h.places.prepare([h.row],h.near); assert.equal(h.calls(),1);
  let extra=0;
  const second=createServerlessPlaces({store:h.store,key:'test',now:()=>1000000,fetch:async()=>{extra++;throw new Error('must stay backed off');}});
  await second.prepare([h.row],h.near); assert.equal(extra,0);
  h.advance(5*60000+1); await h.places.prepare([h.row],h.near); assert.equal(h.calls(),2);
});

test('backfill refuses a different place or an invalid provider match and keeps negative entries untouched',async()=>{
  for(const documents of [
    [{place_name:'다른카페',address_name:'서울 성동구',road_address_name:'서울 성동구 1',x:'127.05',y:'37.54'}],
    [{place_name:'기존카페',address_name:'서울 성동구',road_address_name:'서울 성동구 1',x:'127.07',y:'37.54',place_url:'https://place.map.kakao.com/88'}],
    []
  ]){
    const h=backfillHarness({documents});
    await h.places.prepare([h.row],h.near);
    assert.deepEqual(h.places.get(h.row.placeKey),h.old);
    assert.equal(h.writes.filter(w=>w.scope==='place').length,0);
    await h.places.prepare([h.row],h.near); assert.equal(h.calls(),1);
  }
  const h=backfillHarness();h.values.place[h.row.placeKey]={s:'ambiguous',t:1000000};
  await h.places.prepare([h.row],h.near);assert.equal(h.calls(),0);
});
