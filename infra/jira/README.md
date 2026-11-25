# Jira setup

`setup.js` prepares Jira for this project through the official Jira Cloud REST API v3. It does three things:

1. Uses the project **MOA** (모아체험, Kanban) on the Atlassian Cloud site configured in `JIRA_BASE_URL`, creating it if it does not exist.
2. Registers three backlog issues:
   - External DB migration
   - Vercel deployment
   - Jenkins pipeline connection
3. Links the external DB issue as *blocks* Vercel deployment.

No npm dependencies (Node 22+).

## Credentials

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>. Save it in a file **outside this repository**, for example `%LOCALAPPDATA%\Product-Seeding-Automation\jira.env`:

```
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=<Atlassian account email>
JIRA_API_TOKEN=<API token>
```

`.gitignore` ignores `*.env`, but keep the file out of the repo anyway. The script sends the token only in the `Authorization` header and never prints it. Revoke the token when it is no longer needed.

## Run

```powershell
node infra/jira/setup.js --env "$env:LOCALAPPDATA\Product-Seeding-Automation\jira.env" --dry-run   # read-only check
node infra/jira/setup.js --env "$env:LOCALAPPDATA\Product-Seeding-Automation\jira.env"
```

- **Re-running is safe.** The existing MOA project is reused, and each issue is found again by its label (`psa-external-db`, `psa-vercel-deploy`, `psa-jenkins-pipeline`) or exact summary. Nothing is duplicated.
- **Admin permission:** creating the project needs the Jira *Administer Jira* permission. The site owner has it.
- **Project template:** the script tries a company-managed Kanban template first and falls back to a team-managed one.
- **Errors:** the script prints Jira's HTTP status and error message, never the credentials.

Tests (Jira mocked): `node --test infra/jira/setup.test.js`

## GitHub link (manual, one time)

1. Jira → **Apps → Explore more apps**. Install the free **GitHub for Jira** app (by Atlassian).
2. Connect your GitHub account and select your project repository.
3. Put issue keys (for example `MOA-1`) in branch names and commit messages. Commits, branches and PRs then show on the issue.
