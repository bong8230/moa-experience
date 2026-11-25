'use strict';
// Run: node --test infra/jira/setup.test.js   (Jira is mocked; no network)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, readEnv, ISSUES } = require('./setup.js');

const ENV = { JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: 'tok-SECRET-123' };

// in-memory Jira: project + issues; records every request
function fakeJira({ projectExists = false, labelsAllowed = true, myselfStatus = 200 } = {}) {
  const state = { project: projectExists ? { key: 'MOA', name: '모아체험', issueTypes: [{ id: '3', name: 'Task', subtask: false }, { id: '5', name: 'Sub-task', subtask: true }] } : null, issues: [], calls: [] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ method: init.method, path: u.pathname, body, auth: init.headers.Authorization });
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => (data ? JSON.stringify(data) : '') });
    if (u.pathname === '/rest/api/3/myself') return myselfStatus === 200 ? reply(200, { accountId: 'acc-1' }) : reply(myselfStatus, { errorMessages: ['Unauthorized'] });
    if (u.pathname === '/rest/api/3/project/MOA') return state.project ? reply(200, state.project) : reply(404, { errorMessages: ['No project could be found with key \'MOA\'.'] });
    if (u.pathname === '/rest/api/3/project' && init.method === 'POST') {
      state.project = { key: body.key, name: body.name, issueTypes: [{ id: '10001', name: '작업', subtask: false }] };
      return reply(201, { key: body.key, id: '10000' });
    }
    if (u.pathname === '/rest/api/3/search/jql') {
      const label = body.jql.match(/labels = "([^"]+)"/)[1];
      return reply(200, { issues: state.issues.filter(i => i.fields.labels.includes(label) || body.jql.includes(i.fields.summary.replace(/["\\]/g, ' '))) });
    }
    if (u.pathname === '/rest/api/3/issue') {
      if (body.fields.labels && !labelsAllowed) return reply(400, { errors: { labels: 'Field \'labels\' cannot be set.' } });
      const key = `MOA-${state.issues.length + 1}`;
      state.issues.push({ key, fields: { summary: body.fields.summary, labels: body.fields.labels || [] }, typeId: body.fields.issuetype.id, description: body.fields.description });
      return reply(201, { key });
    }
    if (u.pathname === '/rest/api/3/issueLink') return reply(201, null);
    return reply(404, { errorMessages: ['unexpected ' + u.pathname] });
  };
  return { state, fetchImpl };
}

test('creates the Kanban project and three issues, then re-run creates nothing', async () => {
  const jira = fakeJira();
  const logs = [];
  const first = await run({ env: ENV, fetchImpl: jira.fetchImpl, log: (...a) => logs.push(a.join(' ')) });
  const create = jira.state.calls.find(c => c.path === '/rest/api/3/project' && c.method === 'POST');
  assert.equal(create.body.key, 'MOA');
  assert.equal(create.body.projectTemplateKey, 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic');
  assert.equal(create.body.leadAccountId, 'acc-1');
  assert.deepEqual(first.issues.map(i => i.key), ['MOA-1', 'MOA-2', 'MOA-3']);
  assert.ok(jira.state.issues.every(i => i.typeId === '10001' && i.description.type === 'doc'));
  assert.ok(jira.state.calls.some(c => c.path === '/rest/api/3/issueLink' && c.body.outwardIssue.key === 'MOA-1' && c.body.inwardIssue.key === 'MOA-2'));
  assert.equal(jira.state.calls[0].auth, 'Basic ' + Buffer.from('me@example.com:tok-SECRET-123').toString('base64'));

  const before = jira.state.calls.length;
  const second = await run({ env: ENV, fetchImpl: jira.fetchImpl, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(jira.state.issues.length, 3, 'no duplicates');
  assert.ok(second.issues.every(i => !i.created));
  assert.ok(!jira.state.calls.slice(before).some(c => c.method === 'POST' && c.path !== '/rest/api/3/search/jql'), 'no writes on re-run');
  assert.ok(logs.some(l => l.includes('reusing existing project MOA')));
  assert.ok(logs.every(l => !l.includes('tok-SECRET-123') && !l.includes('me@example.com')), 'credentials never logged');
});

test('existing project is reused and issues fall back to no labels, still deduplicated by summary', async () => {
  const jira = fakeJira({ projectExists: true, labelsAllowed: false });
  await run({ env: ENV, fetchImpl: jira.fetchImpl, log: () => {} });
  assert.ok(!jira.state.calls.some(c => c.path === '/rest/api/3/project' && c.method === 'POST'));
  assert.equal(jira.state.issues.length, 3);
  assert.ok(jira.state.issues.every(i => i.typeId === '3'), 'Task type chosen');
  await run({ env: ENV, fetchImpl: jira.fetchImpl, log: () => {} });
  assert.equal(jira.state.issues.length, ISSUES.length, 'summary match prevents duplicates');
});

test('dry run writes nothing; bad credentials and missing fields fail without echoing secrets', async () => {
  const jira = fakeJira();
  await run({ env: ENV, dryRun: true, fetchImpl: jira.fetchImpl, log: () => {} });
  assert.ok(!jira.state.calls.some(c => c.method === 'POST'));
  await assert.rejects(run({ env: ENV, fetchImpl: fakeJira({ myselfStatus: 401 }).fetchImpl, log: () => {} }), err => /Authentication failed \(HTTP 401/.test(err.message) && !err.message.includes('tok-SECRET'));
  await assert.rejects(run({ env: { JIRA_EMAIL: 'x' }, fetchImpl: jira.fetchImpl }), /missing: JIRA_API_TOKEN/);
});

test('readEnv handles BOM, CRLF, quotes and comments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-env-'));
  const f = path.join(dir, 'jira.env');
  fs.writeFileSync(f, '\uFEFF# comment\r\nJIRA_EMAIL = "a@b.c"\r\nJIRA_API_TOKEN=abc=def\r\n');
  assert.deepEqual(readEnv(f), { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'abc=def' });
  fs.rmSync(dir, { recursive: true, force: true });
});
