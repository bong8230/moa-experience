'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
function browser({ campaigns, automaticObserver = false } = {}) {
  const elements = new Map(), handlers = {}, requests = [], scrolled = [];
  const observers = [];
  let clock = Date.now();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', textContent: '', scrollLeft: 0, hidden: false, dataset: {},
      classList: { toggle() {}, remove() {} }, setAttribute() {}, appendChild() {}, focus() {}, append() {},
      addEventListener(event, callback) { handlers[id + ':' + event] = callback; }
    });
    return elements.get(id);
  };
  class Clock extends Date { static now() { return clock; } }
  if (automaticObserver) element('#more').hidden = true;
  const storage = new Map();
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => element('created'), addEventListener() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      const reply = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).startsWith('/api/campaigns')) {
        if (campaigns) return campaigns(url, options);
        const offset = Number(new URL(url, 'http://local').searchParams.get('offset'));
        return reply({ records: [{ id: 'reviewnote:' + (offset + 1), title: 'campaign-' + (offset + 1), source: 'reviewnote', channels: [] }], total: 3, fetchedAt: new Date().toISOString(), categories: [], sources: [], regions: [], channels: [] });
      }
      if (url === '/api/me') return reply({ user: null, authEnabled: true });
      if (url === '/api/preferences') return reply({ preferences: null });
      return reply({ items: [], removed: 1 });
    },
    window: { scrollY: 0, scrollTo: (x, y) => scrolled.push(y), addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: () => null, setItem() {} },
    URL, URLSearchParams, Intl, Date: Clock, Set, Map, String, Math, JSON,
    location: { pathname: '/', search: '' }, navigator: {},
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}, confirm: () => true
  });
  if (automaticObserver) context.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.observations = 0; observers.push(this); }
    observe(target) {
      this.targets.add(target);
      if (target === element('#more') && !target.hidden && ++this.observations < 10) setImmediate(() => {
        if (this.targets.has(target) && !target.hidden) this.callback([{ target, isIntersecting: true }]);
      });
    }
    unobserve(target) { this.targets.delete(target); }
  };
  const script = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').split('<script>')[1].split('</script>')[0];
  vm.runInContext(script, context);
  return {
    run: code => vm.runInContext(code, context), element, handlers, scrolled, context,
    advance: ms => { clock += ms; },
    fireMore: () => { const target = element('#more'); observers.find(o => o.targets.has(target)).callback([{ target, isIntersecting: true }]); },
    listRequests: () => requests.filter(r => r.url.startsWith('/api/campaigns'))
  };
}

test('automatic pagination stops after an error instead of continuously fetching the failed page', async () => {
  const b = browser({ automaticObserver: true, campaigns: async url => {
    if (new URL(url, 'http://local').searchParams.get('offset') !== '0') return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ records: [{ id: 'reviewnote:1', title: 'first page', source: 'reviewnote', channels: [] }], total: 2, fetchedAt: new Date().toISOString(), categories: [], sources: [], regions: [], channels: [] }) };
  } });
  await settle();
  b.fireMore();
  await settle(); await settle();
  assert.equal(b.listRequests().length, 2, 'one initial request and one failed next-page request only');
  assert.equal(b.element('#more').hidden, true);
  assert.match(b.element('#results').innerHTML, /다시 불러오기/);
});

test('all tab restores pages, next offset, more visibility and scroll without another list request', async () => {
  const b = browser(); await settle();
  assert.equal(b.listRequests().length, 1);
  await b.run('load({more:true})');
  assert.equal(b.run('offset'), 2);
  b.context.window.scrollY = 480;
  b.run("setView('saved')"); await settle();
  b.run("setView('all')"); await settle();
  assert.equal(b.listRequests().length, 2);
  assert.equal(b.run('offset'), 2);
  assert.match(b.element('#results').innerHTML, /campaign-1/);
  assert.match(b.element('#results').innerHTML, /campaign-2/);
  assert.equal(b.element('#more').hidden, false);
  assert.equal(b.scrolled.at(-1), 480);
  b.run("setView('hand'); setView('all')"); await settle();
  assert.equal(b.listRequests().length, 2);
  await b.run('load({more:true})');
  assert.equal(new URL(b.listRequests().at(-1).url, 'http://local').searchParams.get('offset'), '2');
  assert.equal(b.element('#more').hidden, true);
});

test('query, TTL and explicit refresh bypass snapshots; failed responses are not cached', async () => {
  const b = browser(); await settle();
  b.element('#search').value = 'new'; await b.run('load()');
  assert.equal(b.listRequests().length, 2);
  await b.run('load()'); assert.equal(b.listRequests().length, 2);
  b.advance(5 * 60 * 1000); await b.run('load()'); assert.equal(b.listRequests().length, 3);
  await b.run('load({refresh:true})');
  assert.equal(new URL(b.listRequests().at(-1).url, 'http://local').searchParams.get('refresh'), '1');
  let attempts = 0;
  const failed = browser({ campaigns: async () => { attempts++; return { ok: false }; } });
  await settle(); failed.run("setView('hand'); setView('all')"); await settle();
  assert.equal(attempts, 2);
});

test('owner switches clear snapshots before account preferences load', async () => {
  const b = browser(); await settle();
  b.run("currentUser={id:'kakao:1', nickname:'one'}");
  await b.run("switchPrefsOwner('kakao:1')"); await settle();
  assert.equal(b.listRequests().length, 2);
  b.run("setView('hand'); setView('all')"); await settle();
  assert.equal(b.listRequests().length, 2);
  b.run('currentUser=null'); await b.run("switchPrefsOwner('guest')"); await settle();
  assert.equal(b.listRequests().length, 3, 'guest does not revive its pre-login snapshot');
});

test('successful restore mutation invalidates all-list snapshots', async () => {
  const b = browser(); await settle();
  b.run("setView('excluded')"); await settle();
  await b.run("runAction('restore-all')"); await settle();
  b.run("setView('all')"); await settle();
  assert.equal(b.listRequests().length, 2);
});

test('successful favorite and exclude mutations force a fresh all-list after tab return', async () => {
  const b = browser(); await settle();
  b.run("currentUser={id:'kakao:1', nickname:'one'}");
  await b.run("switchPrefsOwner('kakao:1')"); await settle();
  const favorite = { dataset: { saved:'false', id:'reviewnote:1' }, setAttribute() {} };
  await b.handlers['#results:click']({ target: { closest: selector => selector === '.favorite-toggle' ? favorite : null } });
  b.run("setView('hand'); setView('all')"); await settle();
  assert.equal(b.listRequests().length, 3, 'favorite changes do not restore the old heart state');
  const article = { dataset: { id:'reviewnote:1' }, remove() {} };
  b.context.markButton = { dataset: {mark:'excluded'}, closest: () => article, getAttribute: () => 'false' };
  await b.run('setMark(markButton)');
  b.run("setView('hand'); setView('all')"); await settle();
  assert.equal(b.listRequests().length, 4, 'excluded cards cannot reappear from a cached snapshot');
});

test('in-flight list work is shared and cannot paint over another tab', async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const b = browser({ campaigns: async () => response }); await settle();
  b.run("setView('saved'); setView('all')"); await settle();
  assert.equal(b.listRequests().length, 1, 'same query reuses the pending request');
  b.run("setView('hand')");
  release({ ok: true, json: async () => ({ records: [{id:'reviewnote:1',title:'late-campaign',source:'reviewnote',channels:[]}], total:1, fetchedAt:new Date().toISOString() }) });
  await settle();
  assert.doesNotMatch(b.element('#results').innerHTML, /late-campaign/);
  b.run("setView('all')"); await settle();
  assert.match(b.element('#results').innerHTML, /late-campaign/);
  assert.equal(b.listRequests().length, 1);
});

test('an old account request cannot populate the next account cache after logout', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const reply = title => ({ ok:true, json:async () => ({records:[{id:'reviewnote:1', title,source:'reviewnote',channels:[]}],total:1,fetchedAt:new Date().toISOString()}) });
  const b = browser({campaigns:async () => ++calls === 1 ? delayed : reply('new-owner')}); await settle();
  b.run("currentUser={id:'kakao:2'}"); await b.run("switchPrefsOwner('kakao:2')"); await settle();
  assert.match(b.element('#results').innerHTML, /new-owner/);
  release(reply('private-old-owner')); await settle();
  assert.doesNotMatch(b.element('#results').innerHTML, /private-old-owner/);
  b.run("setView('hand'); setView('all')"); await settle();
  assert.equal(calls, 2);
  assert.doesNotMatch(b.element('#results').innerHTML, /private-old-owner/);
});
