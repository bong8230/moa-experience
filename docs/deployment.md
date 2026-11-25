# Deployment

PostgreSQL stores sessions, single-use OAuth state, favorites, campaign marks, campaign snapshots and place caches. Local runs without DATABASE_URL retain file storage.

Choose a Vercel function region close to your database. Shared campaign rows use gzip/base64 and still read the legacy records format. Stale snapshots with recent campaigns are served while refreshing; entirely expired snapshots refresh before replying. Explicit refresh waits for fresh data.

Original deadline verification is bounded and runs after the response when Vercel's request context provides waitUntil. The adapter falls back to inline work when unavailable. Check the runtime log `waitUntil available` after deployment. See [deadlines.md](deadlines.md) for supported sources and evidence rules.

`api/index.js` invokes the handler without listening. The build publishes only HTML in `public/`; source and environment paths return 404. `.vercelignore` excludes local secrets and user data from uploads.

Campaigns use a shared database cache. Kakao lookups run within requests, limited to one campaign lookup per nearby request and 500 external searches per KST day. Unmatched stores retain approximate area coordinates. HTTPS supports browser geolocation.

## Configuration

Set DATABASE_URL, KAKAO_REST_API_KEY, KAKAO_CLIENT_SECRET and KAKAO_REDIRECT_URI in your Vercel project. The callback must also be registered in Kakao Developers:

`https://your-project.vercel.app/auth/kakao/callback`

Verify login with your own Kakao app before enabling deployment. Source attribution stays visible; review data-provider permission before expanding this personal deployment into a redistribution service.

Database setup: `node --env-file=.env.local migrations/run.js`. Local saved files are preserved. See migrations/ for the optional import tool.

## Delivery

Set VERCEL_ORG_ID and VERCEL_PROJECT_ID in the Jenkins environment. Authenticate the Vercel CLI under the account that runs Jenkins. Keep tokens outside Git.

Vercel Git auto-deploy is disabled in vercel.json. Jenkins checks main, installs locked dependencies and runs tests. Deployment additionally requires DEPLOY_VERCEL=true, CONFIRM_DEPLOY=DEPLOY and the readiness gate. Production requires a final approval click.

Real isolated Postgres tests cover cross-instance sessions/OAuth, state replay prevention, concurrent saves and account separation.
