# API Server Deployment

## Infrastructure

| Component | Service | Details |
|---|---|---|
| **Backend** | Google Cloud Run | `gtd-api` (production), `gtd-api-staging` (staging), region `us-central1` |
| **Container images** | Google Artifact Registry | Built from `api-server/Dockerfile`, pushed per deploy |
| **Database** | MongoDB Atlas | Shared cluster, separate databases per environment |
| **API proxy** | Cloudflare Worker | `workers/api-proxy/` routes custom domains to Cloud Run |
| **Frontend** | Cloudflare Pages | Static SPA build from `client/` |

### Environments

| Environment | App URL | API URL |
|---|---|---|
| production | https://getting-things-done.app | https://api.getting-things-done.app |
| staging | https://staging.getting-things-done.app | https://api-staging.getting-things-done.app |

---

## How to Deploy

### Push-triggered (recommended)

Push to the `staging` or `production` branch when `api-server/**` files have changed. This triggers `.github/workflows/deploy-api.yml` automatically.

```bash
git push origin main:staging       # deploy to staging
git push origin main:production    # deploy to production (requires reviewer approval)
```

### Manual dispatch

```bash
./scripts/deploy.sh api staging       # triggers workflow via gh workflow run
./scripts/deploy.sh api production
```

Or directly in the GitHub Actions UI: [Deploy API workflow](https://github.com/yuval-yssak/gtd-app/actions/workflows/deploy-api.yml) -> "Run workflow" -> select environment.

### Monitor progress

```bash
gh run list --workflow=deploy-api.yml
gh run watch <run-id>
```

Or visit: https://github.com/yuval-yssak/gtd-app/actions/workflows/deploy-api.yml

---

## GitHub Environments

Configured at https://github.com/yuval-yssak/gtd-app/settings/environments

Each environment (`production`, `staging`) holds its own set of secrets and variables. The `production` environment has required reviewers enabled — pushes to the `production` branch require approval before the deploy job runs.

### Secrets (per environment)

| Secret | Purpose |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider for keyless auth |
| `GCP_SERVICE_ACCOUNT` | Service account email for Cloud Run deploys |
| `MONGO_DB_URL` | MongoDB Atlas connection string |
| `GOOGLE_OAUTH_APP_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_OAUTH_APP_CLIENT_SECRET` | Google OAuth client secret |
| `GH_OAUTH_CLIENT_ID` | GitHub OAuth client ID |
| `GH_OAUTH_CLIENT_SECRET` | GitHub OAuth client secret |
| `BETTER_AUTH_SECRET` | Session signing key (64+ chars) |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key |

### Variables (per environment)

| Variable | Example |
|---|---|
| `GCP_PROJECT_ID` | `gtd-app` |
| `MONGO_DB_NAME` | `gtd` / `gtd_staging` |
| `BETTER_AUTH_URL` | `https://api.getting-things-done.app` |
| `CLIENT_URL` | `https://getting-things-done.app` |
| `VAPID_PUBLIC_KEY` | (base64url-encoded public key) |
| `VAPID_SUBJECT` | `mailto:admin@getting-things-done.app` |

---

## Dockerfile

Multi-stage build in `api-server/Dockerfile`:

1. **Builder stage** (Node 24 Alpine): installs all deps, compiles TypeScript to `build/`
2. **Runtime stage** (Node 24 Alpine): installs production deps only, copies compiled output, exposes port 8080

Cloud Run sets `PORT=8080` automatically. The app reads `process.env.PORT` and defaults to 4000 for local dev.

**Note:** The Dockerfile uses `npm install` instead of `npm ci` because optional WASM dependencies (`@emnapi/*`) resolve differently on macOS vs Linux, causing `npm ci` to fail when the lock file was generated on macOS.

---

## Workflow Details (`deploy-api.yml`)

The workflow:

1. Checks out the repo
2. Authenticates to GCP via **Workload Identity Federation** (keyless — no service account key file)
3. Configures Docker to push to Artifact Registry
4. Builds the image from repo root (`docker build -f api-server/Dockerfile .`) and tags it with the commit SHA
5. Pushes the image to Artifact Registry
6. Deploys to Cloud Run with environment variables written to a YAML file (avoids shell escaping issues with special characters in secrets)

The environment selection (`production` or `staging`) determines:
- Which GitHub Environment's secrets/variables are used
- Which Cloud Run service to deploy to (`gtd-api` vs `gtd-api-staging`)

---

## API Proxy (Cloudflare Worker)

The `workers/api-proxy/` Cloudflare Worker routes requests from the custom domains to the Cloud Run services:

- `api.getting-things-done.app` -> `gtd-api` Cloud Run service
- `api-staging.getting-things-done.app` -> `gtd-api-staging` Cloud Run service

This provides a stable domain with Cloudflare's edge network in front of Cloud Run.

---

## Gotchas

- **SSE is single-process**: The in-memory SSE connection registry doesn't work across multiple Cloud Run instances. Cloud Run is configured with `max-instances=1` to avoid this. Scaling beyond one instance would require Redis pub/sub.
- **Cold starts**: Cloud Run scales to zero. First request after idle may take 2-3 seconds for Node.js to start + MongoDB connection to establish.
- **`npm install` vs `npm ci`**: The Dockerfile intentionally uses `npm install` due to cross-platform lock file issues (see note above).
- **Production requires reviewer approval**: The `production` GitHub Environment has required reviewers. The workflow will pause and wait for approval before deploying.
- **Calendar encryption key**: Not currently in the deploy workflow env vars. Must be added to GitHub Environment secrets if calendar integration is deployed. Changing `CALENDAR_ENCRYPTION_KEY` invalidates all stored OAuth tokens.
- **Service Worker updates**: After deploying a new frontend build, the PWA service worker activates immediately (`skipWaiting`). Users need to reload once to pick up new JS/CSS. Offline users may see broken pages until they reload (see `client/README.md` for details).
