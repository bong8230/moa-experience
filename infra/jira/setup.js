#!/usr/bin/env node
'use strict';
// Create (or reuse) the Jira project MOA and its backlog issues,
// using the official Jira Cloud REST API v3 with an Atlassian API token.
//
//   node infra/jira/setup.js --env <path to jira.env> [--dry-run]
//
// jira.env (keep it OUTSIDE the repository; never commit it):
//   JIRA_BASE_URL=https://your-site.atlassian.net
//   JIRA_EMAIL=<Atlassian account email>
//   JIRA_API_TOKEN=<API token from id.atlassian.com>
//
// Safe to re-run: an existing MOA project is reused and each issue is created only once
// (found again by its label). The token is used only in the Authorization header and is never printed.
const fs = require('node:fs');

const PROJECT = { key: 'MOA', name: '모아체험', description: '체험단 공고 모아보기 (Product-Seeding-Automation)' };
// company-managed Kanban first; team-managed Kanban as a fallback
const TEMPLATES = ['com.pyxis.greenhopper.jira:gh-simplified-kanban-classic', 'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban'];

const ISSUES = [
  {
    label: 'psa-external-db',
    summary: '외부 DB 전환: 세션·OAuth state·찜·지원/제외 표시·매장 좌표 캐시',
    body: [
      '현재 로그인 세션과 OAuth state는 서버 메모리(Map), 찜과 지원/제외 표시는 preview/data/*.json, 카카오 매장 좌표 캐시는 preview/data/kakao-places.json에 있다.',
      'Vercel 같은 서버리스 환경에서는 인스턴스끼리 공유되지 않고 디스크에 쓸 수 없으므로 외부 DB로 옮겨야 한다.',
      '완료 조건: createApp 뒤에 저장소 계층을 두고(로컬은 파일, 배포는 DB), 세션·state(TTL)·찜·표시·매장 캐시가 여러 요청과 콜드 스타트 뒤에도 유지된다. 키는 환경변수로만 넣는다.',
      `참고: docs/deployment.md`
    ]
  },
  {
    label: 'psa-vercel-deploy',
    summary: 'Vercel 배포: 함수 진입점·환경변수·Git 자동배포 끄기·카카오 도메인 등록',
    body: [
      '선행: 외부 DB 전환.',
      'api/ 함수 진입점(createApp().handler 재사용)과 vercel.json을 추가하고 vercel.json에 {"git":{"deploymentEnabled":false}}를 넣어 Git push 자동 배포를 끈다(배포는 Jenkins만).',
      'Vercel 환경변수(KAKAO_REST_API_KEY, KAKAO_CLIENT_SECRET, KAKAO_REDIRECT_URI, DB URL)를 대시보드에 설정하고, 카카오 개발자 콘솔에 Vercel 도메인과 /auth/kakao/callback Redirect URI를 등록한다.',
      '공고 원본(Richophie/review_search, LICENSE 없음)의 공개 사용 허락을 확인하거나 접근을 제한한다.',
      '완료 조건: preview 배포에서 로그인·찜·표시가 동작하고, docs/vercel-readiness.json을 ready:true로 바꾸는 커밋이 리뷰된다.',
      `참고: docs/deployment.md`
    ]
  },
  {
    label: 'psa-jenkins-pipeline',
    summary: 'Jenkins 파이프라인 연결: Pipeline from SCM·credential·첫 빌드',
    body: [
      '로컬 Jenkins(http://127.0.0.1:18080)에 Pipeline 잡 product-seeding-automation을 만들고 Script Path는 Jenkinsfile, 브랜치는 main.',
      'GitHub 읽기 전용 credential을 등록하고, 배포가 가능해지면 vercel-token / vercel-org-id / vercel-project-id(Secret text)를 추가한다.',
      '완료 조건: 기본 파라미터 빌드에서 Environment·Secret guard·Test(node --test preview/*.test.js)가 통과하고, DEPLOY_VERCEL=true 빌드는 readiness 단계에서 막힌다.',
      `참고: docs/jenkins.md`
    ]
  }
];

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const adf = paragraphs => ({ type: 'doc', version: 1, content: paragraphs.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

function createClient({ baseUrl, email, token, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  return async function api(method, path, body) {
    const res = await fetchImpl(baseUrl + path, {
      redirect: 'error',
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, ok: res.ok, data };
  };
}

// Jira error bodies hold field names and messages, never credentials
function why(r) {
  const d = r.data || {};
  const parts = [...(d.errorMessages || []), ...Object.entries(d.errors || {}).map(([k, v]) => `${k}: ${v}`)];
  return `HTTP ${r.status}${parts.length ? ' ' + parts.join('; ') : ''}`;
}

async function run({ env, dryRun = false, fetchImpl = fetch, log = console.log }) {
  const missing = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_BASE_URL'].filter(k => !env[k]);
  if (missing.length) throw new Error(`jira.env is missing: ${missing.join(', ')}`);
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/i.test(env.JIRA_BASE_URL)) {
    throw new Error('JIRA_BASE_URL must be an Atlassian Cloud site URL.');
  }
  const baseUrl = env.JIRA_BASE_URL.replace(/\/$/, '');
  const api = createClient({ baseUrl, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN, fetchImpl });

  const me = await api('GET', '/rest/api/3/myself');
  if (!me.ok) throw new Error(`Authentication failed (${why(me)}). Check JIRA_EMAIL / JIRA_API_TOKEN.`);
  log('authenticated to', baseUrl);

  let project = await api('GET', `/rest/api/3/project/${PROJECT.key}`);
  if (project.status === 404) {
    if (dryRun) { log(`[dry-run] would create project ${PROJECT.key} (${PROJECT.name}, Kanban)`); return { project: null, issues: [] }; }
    let created = null;
    for (const template of TEMPLATES) {
      const r = await api('POST', '/rest/api/3/project', {
        key: PROJECT.key, name: PROJECT.name, description: PROJECT.description,
        projectTypeKey: 'software', projectTemplateKey: template,
        leadAccountId: me.data.accountId, assigneeType: 'UNASSIGNED'
      });
      if (r.ok) { created = r; log(`created project ${PROJECT.key} (template ${template.split(':')[1]})`); break; }
      if (r.status === 401 || r.status === 403) throw new Error(`Project creation not allowed (${why(r)}). The account needs the Jira "Administer Jira" permission.`);
      log(`template ${template.split(':')[1]} rejected: ${why(r)}`);
    }
    if (!created) throw new Error(`Could not create project ${PROJECT.key}; see the messages above.`);
    project = await api('GET', `/rest/api/3/project/${PROJECT.key}`);
  } else if (project.ok) {
    log(`reusing existing project ${PROJECT.key} (${project.data.name})`);
  }
  if (!project.ok) throw new Error(`Cannot read project ${PROJECT.key} (${why(project)}).`);

  const types = (project.data.issueTypes || []).filter(t => !t.subtask);
  const type = ['Task', '작업', 'Story', '스토리'].map(n => types.find(t => t.name === n)).find(Boolean) || types[0];
  if (!type) throw new Error(`Project ${PROJECT.key} has no usable issue type.`);

  const results = [];
  for (const issue of ISSUES) {
    // found again by label, or by exact summary if labels were not accepted earlier
    const jql = `project = ${PROJECT.key} AND (labels = "${issue.label}" OR summary ~ "\\"${issue.summary.replace(/["\\]/g, ' ')}\\"")`;
    const found = await api('POST', '/rest/api/3/search/jql', { jql, fields: ['summary', 'labels'], maxResults: 5 });
    if (!found.ok) throw new Error(`Issue search failed (${why(found)}).`);
    const same = (found.data.issues || []).find(i => (i.fields.labels || []).includes(issue.label) || i.fields.summary === issue.summary);
    if (same) { results.push({ key: same.key, summary: issue.summary, created: false }); log(`exists  ${same.key}  ${issue.summary}`); continue; }
    if (dryRun) { results.push({ key: null, summary: issue.summary, created: false }); log(`[dry-run] would create: ${issue.summary}`); continue; }
    const fields = { project: { key: PROJECT.key }, issuetype: { id: type.id }, summary: issue.summary, description: adf(issue.body), labels: ['psa-setup', issue.label] };
    let r = await api('POST', '/rest/api/3/issue', { fields });
    if (!r.ok && r.data && r.data.errors && r.data.errors.labels) {
      const { labels: _labels, ...rest } = fields; // labels field not on this project's create screen
      r = await api('POST', '/rest/api/3/issue', { fields: rest });
    }
    if (!r.ok) throw new Error(`Creating "${issue.summary}" failed (${why(r)}).`);
    results.push({ key: r.data.key, summary: issue.summary, created: true });
    log(`created ${r.data.key}  ${issue.summary}`);
  }

  // external DB blocks Vercel deployment (best effort; skipped if the link type does not exist)
  const [db, vercel] = results;
  if (!dryRun && db && vercel && (db.created || vercel.created)) {
    const link = await api('POST', '/rest/api/3/issueLink', { type: { name: 'Blocks' }, outwardIssue: { key: db.key }, inwardIssue: { key: vercel.key } });
    log(link.ok ? `linked ${db.key} blocks ${vercel.key}` : `link skipped (${why(link)})`);
  }

  log(`board: ${baseUrl}/jira/software/projects/${PROJECT.key}/boards`);
  log('GitHub link: install GitHub for Jira and choose the repository in the integration settings.');
  log(`Put issue keys (e.g. ${results[0]?.key || 'MOA-1'}) in branch names and commit messages so they appear on the issue.`);
  return { project: PROJECT.key, issues: results };
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--env');
  const file = i >= 0 ? args[i + 1] : null;
  if (!file) { console.error('usage: node infra/jira/setup.js --env <path to jira.env> [--dry-run]'); process.exit(2); }
  if (!fs.existsSync(file)) { console.error(`env file not found: ${file}`); process.exit(2); }
  try {
    await run({ env: readEnv(file), dryRun: args.includes('--dry-run') });
  } catch (err) {
    console.error('jira setup failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { run, readEnv, ISSUES, PROJECT };
