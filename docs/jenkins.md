# Jenkins pipeline

Jenkins runs locally at <http://127.0.0.1:18080/> and listens on loopback only. For install, start and stop, see [`infra/jenkins/README.md`](../infra/jenkins/README.md). The pipeline is defined in the root [`Jenkinsfile`](../Jenkinsfile).

## Requirements on the PC

- Node.js 22 or newer on the `PATH` of the user that starts Jenkins (`node --test` with a glob pattern needs Node 21+).
- Git on the `PATH`.
- Jenkins plugins:
  - Pipeline
  - Git
  - Credentials Binding (for `withCredentials`)
  - GitHub, if the job polls or receives webhooks from GitHub.

## Create the job

1. **New Item** → **Pipeline**. Name it `product-seeding-automation`.
2. **Pipeline** → *Definition*: **Pipeline script from SCM** → Git. Use the project's GitHub repository URL and branch `*/main`.
   - Private repository: add a GitHub credential in Jenkins and select it there.
   - Use a fine-grained personal access token with read-only *Contents* access to this repository, or a deploy key.
3. *Script Path*: `Jenkinsfile`.
4. Run **Build Now** once. Jenkins reads the `Jenkinsfile` and adds the build parameters.

## Stages

| Stage | What it does | Runs |
| --- | --- | --- |
| Environment | Prints the Node version; fails if Node < 22 | Always |
| Secret guard | Fails if `preview/.env`, `preview/data/` or `.env` is tracked by git | Always |
| Dependencies | `npm ci --ignore-scripts --no-audit --no-fund` | Always |
| Test | `node --test preview/*.test.js` (Kakao and the data source are mocked; no network) | Always |
| Deploy readiness | Requires `CONFIRM_DEPLOY=DEPLOY`, branch `main`, and `docs/vercel-readiness.json` `"ready": true` | `DEPLOY_VERCEL=true` only |
| Approve production | Waits for a manual click | `DEPLOY_VERCEL=true` and `VERCEL_TARGET=production` |
| Deploy to Vercel | `npx vercel@65.15.0 deploy` using the local user's authenticated CLI profile | `DEPLOY_VERCEL=true` only |

A normal build (default parameters) only runs checks and tests. It never deploys. While the readiness file says `"ready": false`, a build with `DEPLOY_VERCEL=true` stops at **Deploy readiness**. The build log lists the blockers. See [deployment.md](deployment.md).

## Deployment authentication

Jenkins runs as the same Windows user authenticated with Vercel CLI. The CLI refreshes its OAuth profile without copying an expiring access token into Jenkins. Configure VERCEL_PROJECT_ID and VERCEL_ORG_ID in the Jenkins environment. Kakao keys are stored in Vercel, not Jenkins. Never put a token in a build parameter or commit.

## Notes

- Jenkins started by `infra/jenkins/start.ps1` is not a Windows service. Builds run only while it is running.
- Jira: put the issue key in commit messages and branch names (for example `PSA-12 add storage layer`) so Jira's GitHub integration can link them.
