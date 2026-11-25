# Product-Seeding-Automation (모아체험)

모아체험 is a viewer for Korean product-seeding campaigns (체험단). It gathers open campaigns from several 체험단 sites into one list, sorted by deadline. The list can be filtered by region, review channel, category and site, or searched by radius around a location. With a Kakao login, campaigns can be saved and marked as applied or excluded.

## Structure

| Path | Contents |
| --- | --- |
| `preview/server.js` | Node HTTP server, `/api/*` routes and Kakao login (`createApp`) |
| `preview/index.html` | Single-page UI |
| `preview/geo.js`, `preview/geo/kr-places.json` | Region text → administrative-area centroid |
| `preview/kakao-local.js` | Optional precise store coordinates via Kakao Local |
| `preview/*.test.js` | Tests (`node:test`, no network) |
| `infra/jenkins/` | Local Jenkins start/stop scripts |
| `Jenkinsfile` | CI pipeline (tests; deployment gated) |
| `docs/` | [Deployment status](docs/deployment.md), [Jenkins setup](docs/jenkins.md) |

## Run locally

Requires Node.js 22+. Install dependencies with `npm ci`.

```powershell
# optional: Kakao login / Kakao Local. Create preview/.env (never commit it):
#   KAKAO_REST_API_KEY=...
#   KAKAO_CLIENT_SECRET=...
#   KAKAO_REDIRECT_URI=http://127.0.0.1:8787/auth/kakao/callback
node preview/server.js
```

- **Address:** open <http://127.0.0.1:8787>. The server binds `127.0.0.1` by default. Set `HOSTS` for another private interface. It refuses `0.0.0.0`.
- **Without Kakao settings:** the campaign list still works.
- **Kakao Local:** set `KAKAO_LOCAL=0` to turn off store lookups.

## Test

```powershell
node --test preview/*.test.js
```

## Data and attribution

- **Campaigns:** fetched live from the public snapshot of [Richophie/review_search](https://github.com/Richophie/review_search), cached for 30 minutes and not redistributed. Each campaign links to its original site.
- **Sites without collection:** Musinsa, Kakao gift and Coupang campaigns are not collected automatically. Their robots rules or terms do not allow it, so the UI only links to them.
- **Region centroids:** Statistics Korea SGIS administrative boundaries (KOGL Type 1), processed by [vuski/admdongkor](https://github.com/vuski/admdongkor) (CC BY 4.0).
- **Store locations:** Kakao Local keyword search, when enabled.

## Security

- **Secrets:** they live only in `preview/.env` (local) or Jenkins/Vercel credential stores. `.gitignore` excludes `.env` files and `preview/data/`.
- **Network:** never bind a public interface, and do not use `tailscale funnel`.
- **Deployment:** Vercel deployment requires your own PostgreSQL instance and deployment configuration. See [docs/deployment.md](docs/deployment.md).
