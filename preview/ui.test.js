const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('지역을 선택하면 공고 조회에 지역이 전달된다', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const handlers = {};
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', textContent: '', scrollLeft: 0,
      classList: { toggle() {}, remove() {} }, setAttribute() {}, appendChild() {},
      addEventListener(event, callback) { handlers[id + ':' + event] = callback; }
    });
    return elements.get(id);
  }
  const requests = [];
  const context = {
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => element('article'), addEventListener() {} },
    fetch: async url => {
      requests.push(String(url));
      if (url === '/api/me') return { ok: true, json: async () => ({ authEnabled: false, user: null }) };
      return { ok: true, json: async () => ({ categories: [], sources: [], regions: ['서울'], channels: ['블로그', '인스타그램'], records: [], total: 0, fetchedAt: new Date().toISOString() }) };
    },
    URL, URLSearchParams, Intl, Date, Set, String, Math, location: { pathname: '/' },
    navigator: {}, setInterval() {}, setTimeout, clearTimeout, alert() {}, confirm() { return false; }
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  const listRequests = () => requests.filter(url => url.startsWith('/api/campaigns'));
  const lastParams = () => new URL(listRequests().at(-1), 'http://localhost').searchParams;
  element('#filter-panel').hidden = true;
  handlers['#filter-toggle:click']();
  assert.equal(element('#filter-panel').hidden, false, 'panel opens');
  const before = listRequests().length;
  handlers['#regions:click']({ target: { dataset: { region: '서울' } } });
  handlers['#channels:click']({ target: { dataset: { channel: '인스타그램' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listRequests().length, before, 'choices in the panel do not query until 확인');
  handlers['#draft-apply:click']();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('#filter-panel').hidden, true, '확인 closes the panel');
  assert.equal(lastParams().get('region'), '서울');
  assert.equal(lastParams().get('channel'), '인스타그램');
  // reopen, change, close without 확인: the applied conditions stay
  handlers['#filter-toggle:click']();
  handlers['#regions:click']({ target: { dataset: { region: '서울' } } });
  handlers['#filter-toggle:click']();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lastParams().get('region'), '서울', 'cancelled draft is dropped');
});
