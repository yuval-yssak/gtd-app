# GTD API Server

Backend for the [Getting Things Done](https://gettingthingsdone.com/) productivity app. Built with **Hono**, **MongoDB**, and **TypeScript**.

## Quick Start

```bash
cp .env.example .env   # fill in required values (see Environment Variables below)
npm install
npm run dev            # starts on http://localhost:4000 with hot reload
```

Or with Docker:

```bash
docker compose up      # MongoDB on :27017, API on :4000
```

## Commands

```bash
npm run dev          # tsx watch — hot reload on port 4000
npm run build        # compile TypeScript to build/
npm start            # node build/index.js (production)
npm test             # run Vitest tests
npm run lint         # Biome lint check
npm run lint:fix     # auto-fix lint + format
npm run typecheck    # tsc --noEmit
```

## Architecture

### Request Lifecycle

1. `index.ts` calls `loadDataAccess()` — connects MongoDB, initializes all DAOs, creates the Better Auth instance
2. Hono app is built in `index.ts` (no separate `app.ts`), routes registered
3. `@hono/node-server` starts listening on `PORT` (default 4000)

### Directory Layout

```
src/
├── index.ts                       # Hono app, route registration, server start
├── config.ts                      # Centralized config (MongoDB, client URL)
├── env.d.ts                       # Environment variable type declarations
├── auth/
│   ├── betterAuth.ts              # Better Auth OAuth config (Google + GitHub)
│   ├── middleware.ts              # authenticateRequest — session → Hono context
│   ├── apiTokens.ts               # Public-API token issuance + bearer resolver (sha256 storage)
│   ├── bearerMiddleware.ts        # authenticateBearer — Authorization: Bearer gtd_… → c.var.apiAuth
│   └── constants.ts               # Cookie name constant
├── routes/
│   ├── sync.ts                    # Sync endpoints (bootstrap, push, pull, SSE)
│   ├── v1/                        # Public REST API — split per entity (items, people, work-contexts) + projections
│   ├── push.ts                    # Web Push subscription management
│   ├── calendar.ts                # Google Calendar OAuth + management
│   └── devLogin.ts                # Dev-only login + token mint (non-production)
├── dataAccess/
│   ├── abstractDAO.ts             # Generic MongoDB wrapper (CRUD, bulk, aggregation)
│   ├── itemsDAO.ts                # Items collection (incl. externalId / contentHash indexes)
│   ├── operationsDAO.ts           # Sync operation log
│   ├── apiTokensDAO.ts            # Personal API tokens (hashed plaintext)
│   ├── routinesDAO.ts             # Recurring task templates
│   ├── peopleDAO.ts               # Contacts
│   ├── workContextsDAO.ts         # Context tags
│   ├── deviceSyncStateDAO.ts      # Per-device sync cursors
│   ├── pushSubscriptionsDAO.ts    # Web Push endpoints
│   ├── calendarIntegrationsDAO.ts # OAuth tokens (encrypted at rest)
│   └── calendarSyncConfigsDAO.ts  # Per-calendar sync state + webhooks
├── calendarProviders/
│   ├── CalendarProvider.ts        # Provider interface
│   └── GoogleCalendarProvider.ts  # Google Calendar API implementation
├── lib/
│   ├── sseConnections.ts          # In-memory SSE connection registry
│   ├── webPush.ts                 # Web Push notification sender
│   ├── operationHelpers.ts        # Operation recording utilities
│   ├── calendarPushback.ts        # Push app changes to Google Calendar
│   ├── tokenEncryption.ts         # AES-256-GCM encryption for OAuth tokens
│   └── typeUtils.ts               # Utility type guards
├── types/
│   ├── entities.ts                # Core entity interfaces (Item, Routine, etc.)
│   └── authTypes.ts               # Hono context types for auth
├── loaders/
│   └── mainLoader.ts              # MongoDB connection + DAO initialization
└── tests/
    ├── sync.test.ts               # Sync endpoint tests
    ├── auth.test.ts               # Authentication tests
    ├── calendar.test.ts           # Calendar integration tests
    ├── tokenEncryption.test.ts    # Encryption tests
    ├── v1Items.test.ts            # Public /v1 API tests (bearer auth, dedupe, pagination, complete)
    └── helpers.ts                 # Test utilities (oauthLogin, authenticatedRequest)
```

## API Endpoints

### Auth (Better Auth)

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/auth/*` | All OAuth flows handled by Better Auth (Google, GitHub) |

### Sync

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/sync/bootstrap` | Yes | Full snapshot of all entities for new/re-syncing devices |
| `GET` | `/sync/pull?since=<ISO>&deviceId=<UUID>` | Yes | Incremental — operations since timestamp |
| `POST` | `/sync/push` | Yes | Client pushes `{ deviceId, ops[] }` — last-write-wins |
| `GET` | `/sync/events` | Yes | SSE stream — real-time change notifications |
| `GET` | `/sync/config` | No | Returns `{ vapidPublicKey }` for Web Push |

### Web Push

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/push/subscribe` | Yes | Register push subscription `{ deviceId, endpoint, keys }` |
| `DELETE` | `/push/subscribe` | Yes | Unregister push subscription `{ deviceId }` |

### Calendar

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/calendar/integrations` | Yes | List user's calendar integrations (tokens redacted) |
| `GET` | `/calendar/auth/google` | Yes | Start Google OAuth flow (HMAC-signed state) |
| `GET` | `/calendar/auth/google/callback` | No | OAuth callback — exchanges code for tokens |
| `PATCH` | `/calendar/integrations/:id` | Yes | Update integration (e.g. change target calendar) |
| `DELETE` | `/calendar/integrations/:id?action=...` | Yes | Unlink integration (`keepEvents`, `deleteEvents`, `deleteAll`) |

### Public API (`/v1/*`)

External integrations and the local MCP server. All endpoints take `Authorization: Bearer gtd_<token>`. Full contract: [`docs/PUBLIC_API.md`](../docs/PUBLIC_API.md).

| Method | Path | Scope |
|--------|------|-------|
| `POST` | `/v1/items` | `items.capture` |
| `POST` | `/v1/items/bulk` | `items.capture` |
| `GET` | `/v1/items` | `items.read` |
| `GET` | `/v1/items/:id` | `items.read` |
| `PATCH` | `/v1/items/:id` | `items.write` |
| `POST` | `/v1/items/:id/complete` | `items.write` |
| `POST/GET/PATCH/DELETE` | `/v1/routines[…]` | `routines.read` / `routines.write` |
| `POST` | `/v1/routines/:id/{pause,resume,split}` | `routines.write` |
| `POST/GET/PATCH/DELETE` | `/v1/people[…]` | `people.read` / `people.write` |
| `POST/GET/PATCH/DELETE` | `/v1/work-contexts[…]` | `contexts.read` / `contexts.write` |
| `POST` | `/v1/reassign` | `reassign` (caller) + `reassign.accept` (recipient via `X-Reassign-Recipient-Token`) |
| `POST` | `/v1/operations/batch` | every scope required by any op in the batch |
| `POST/GET/DELETE` | `/v1/webhooks[…]` | `webhooks.manage` |
| `POST` | `/v1/claude/assist`, `/v1/claude/assist/apply` | `claude.assist` |
| `GET` | `/v1/me` | any minted scope |

Public-API mutations record an `OperationInterface` with `deviceId="api:<tokenId>"` and reuse the same SSE / web-push / GCal pushback / webhook pipeline as `/sync/push` — first-party clients see public-API writes live without any extra wiring. `/v1/reassign` is the bearer-token analog of the in-app device-multi-session check: the caller's `reassign`-scoped token signs the request and the recipient's `reassign.accept`-scoped token rides along in `X-Reassign-Recipient-Token`. Without both, the route refuses.

#### Local MCP server

`mcp-server/` exposes the entire `/v1` surface as MCP tools (`gtd_capture`, `gtd_list_items`, `gtd_reassign`, …) for use from Claude Desktop / Claude Code. It supports multiple accounts in one session via numbered env vars:

```jsonc
{
  "mcpServers": {
    "gtd": {
      "command": "node",
      "args": ["/path/to/gtd/mcp-server/dist/index.js"],
      "env": {
        "GTD_API_BASE": "http://localhost:4000",
        "GTD_API_TOKEN": "gtd_…",      // default account
        "GTD_API_TOKEN_WORK": "gtd_…"  // addressable as account="work"
      }
    }
  }
}
```

See [`mcp-server/README.md`](../mcp-server/README.md) for tool inventory and the cross-account `gtd_reassign` worked example.

### Dev (non-production only)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/dev/login` | Upserts user by email, returns session cookie |
| `POST` | `/dev/api-tokens` | Mint an API token for the logged-in user (returns plaintext once). Capped at 50/user. |
| `DELETE` | `/dev/reset` | Wipes all collections (test cleanup) |

## Authentication

Two parallel auth modes share the same user identity space.

### Better Auth (cookie sessions) — first-party client

- **Providers:** Google and GitHub. Accounts with the same email are automatically linked to one user.
- **Session:** Stored in MongoDB (`session` collection). HTTP-only cookie `better-auth.session_token`.
- **Middleware:** `authenticateRequest` calls `auth.api.getSession()`, attaches session to the Hono context.
- **User ID:** Access via `c.get('session').user.id` — a UUID string (not ObjectId).
- **Collections managed by Better Auth:** `user`, `session`, `account`, `verification`.

In production, cookies are `Secure` with `SameSite=none` for cross-domain API access.

### Bearer tokens (`gtd_<random>`) — public `/v1/*` API

- **Issuance:** `issueApiToken(userId, label)` in `src/auth/apiTokens.ts`. The plaintext is returned once and never stored — only its sha256 hash lives in the `apiTokens` collection.
- **Resolution:** `resolveBearerToken(authorizationHeader)` looks up by `tokenHash`, rejects revoked rows.
- **Middleware:** `authenticateBearer` (`src/auth/bearerMiddleware.ts`) parses `Authorization: Bearer gtd_<…>` and sets `c.var.apiAuth = { userId, tokenId }`. Bumps `lastUsedTs` fire-and-forget.
- **Token mint:** `POST /dev/api-tokens` is the only mint route today. A production-safe `POST /account/tokens` plus a settings-page UI is tracked in [issue #19](https://github.com/yuval-yssak/gtd-app/issues/19); without it, staging and production are deployed-but-inert (every `/v1/*` call returns 401).

A bearer-authenticated request and a cookie-authenticated request resolve to the same `user.id`. The two modes do not coexist on a single endpoint — `/v1/*` is bearer-only; everything else is cookie-only.

## Sync Architecture

The sync system uses three channels to keep all devices up to date:

### 1. Operations Log (conflict-free merge)

Every mutation to any entity is recorded as an `OperationInterface` document storing a **full entity snapshot** (not a diff). Conflict resolution is last-write-wins by `updatedTs`.

**Client push flow:**
1. Client sends `{ deviceId, ops[] }` to `POST /sync/push`
2. Server applies each op: compares incoming `updatedTs` vs current DB state
3. If incoming is newer → upsert entity + record operation
4. Notifies other devices via SSE + Web Push

**Client pull flow:**
1. Client calls `GET /sync/pull?since=<lastSyncedTs>`
2. Server returns all operations with `ts > since`
3. Client applies them locally (last-write-wins)

### 2. Real-time Notifications

- **SSE** (`GET /sync/events`) — for open tabs, immediate updates
- **Web Push** — for closed tabs, Service Worker wakes up and syncs

**Gotcha:** The SSE registry is in-memory (single process). Multi-instance deploys (e.g. multiple Cloud Run instances) would need Redis pub/sub for cross-instance broadcasts.

### 3. Operation Purging

Operations older than `min(lastSyncedTs)` across all of a user's devices are purged after each sync push. This prevents unbounded growth. A device that falls behind can always call `/sync/bootstrap` to get a fresh snapshot.

## Calendar Integration

### OAuth Flow

1. User clicks "Connect Google Calendar" in the client
2. `GET /calendar/auth/google` redirects to Google OAuth with an HMAC-signed state parameter (CSRF protection)
3. Google redirects back to `/calendar/auth/google/callback`
4. Server exchanges the authorization code for access + refresh tokens
5. Tokens are encrypted with AES-256-GCM and stored in `calendarIntegrations`

### Sync Strategy

- **Incremental sync:** Uses Google's `syncToken` to fetch only changed events
- **Full re-sync:** If `syncToken` expires (410 Gone), fetches all events from `timeMin`
- **Webhook notifications:** Registers push channels with Google for real-time event changes
- **Echo avoidance:** Tracks `lastPushedToGCalTs` to skip the app's own changes coming back via webhook

### Calendar Pushback

When items change in the app, the server pushes changes to Google Calendar:

| App Action | Google Calendar Effect |
|---|---|
| Create `calendar` item | Create Google event |
| Edit `calendar` item | Update Google event |
| Complete/trash `calendar` item | Delete Google event |
| Create `fixedSchedule` routine | Create recurring event series (RRULE) |

Calendar pushback is fire-and-forget — it doesn't block the sync response. Errors are logged but not thrown.

### `invalid_grant` escalation

When Google rejects a refresh token (revoke, password change, idle, admin policy), the integration is escalated through a 24-hour, time-based state machine in `src/lib/calendarAuthEscalation.ts`:

1. First detected `invalid_grant` → status flips `active` → `suspended`, warning email sent. Sync still attempts (the failure may have been transient).
2. Still failing 24 h after `suspendedAt` → status flips `suspended` → `revoked`, final email sent. Sync/pushback skip; the sync endpoint returns HTTP 410 Gone with `{ error: 'integration_revoked', integrationId, suspendedAt, revokedAt }`.
3. Reconnect via OAuth (`upsertEncrypted`) clears status back to `active` and unsets all escalation timestamps.

The grace window can be shortened for dev/tests via `CALENDAR_AUTH_GRACE_MS` (milliseconds; default 24 h). Detection is centralized in `isInvalidGrantError` (`src/calendarProviders/GoogleCalendarProvider.ts`) and applied at provider call sites with `withAuthFailureHandling(integrationId, () => provider.*)`.

## Public API (`/v1/*`)

A bearer-token-authenticated REST surface for external integrations and the local MCP server in `mcp-server/`. Distinct from `/sync/*`, which is the internal offline-first protocol used by the first-party client. The full contract — request/response shapes, scope matrix, the status×field rules for items, idempotency, and the cross-account reassign two-token gesture — lives in [`docs/PUBLIC_API.md`](../docs/PUBLIC_API.md). This section just highlights the design tenets that aren't re-stated there.

### Design tenets

1. **Reuse the sync pipeline, don't bypass it.** Every public-API mutation flows through `applyAndPublishOperation` — the same shared pipeline that backs `/sync/push` — so validation, persistence, the operations log, and the SSE / web-push / GCal pushback / webhook fan-out all happen exactly once per write. `/v1/reassign` is now no exception: each move publishes a delete on the source user and a create on the target user, both fanning out, so external webhook subscribers see cross-account moves at parity with all other writes.
2. **`deviceId="api:<tokenId>"`** distinguishes public-API ops from real-device ops in the operations log, without polluting the `deviceSyncState` per-device-cursor table. Stale-device purging continues to work normally.
3. **Allowlist response projection.** `presentItem` returns a `Pick<>`-narrowed view of `ItemInterface` so internal sync-anchor fields (`contentHash`, `lastPushedToGCalTs`, `lastSyncedFromGCalTs`, `lastSyncedNotes`) cannot leak into the public schema even if a future field is added without thinking about it. The same allowlist discipline applies to routines, people, and workContexts.

### Token mint surface

Tokens are minted from the **Settings → Personal API tokens** UI in the client, which calls `POST /account/tokens` (cookie-authed, per-user cap of 20 active tokens, plaintext returned exactly once). `GET /account/tokens` lists, `DELETE /account/tokens/:id` revokes — see `routes/tokens.ts`. The legacy `POST /dev/api-tokens` (gated by `NODE_ENV !== 'production'`) is the dev convenience shortcut and is intentionally absent from production deploys.

## Email (stub)

Outbound email is currently a stub. `src/lib/emailStub.ts` exposes `sendEmail(...)`, which (a) writes a row to the `sentEmails` MongoDB collection and (b) logs `[email-stub] kind=... to=... subject=...`. No external email provider is wired up.

Callers today:
- Calendar OAuth escalation (warning + final email when a Google integration is suspended/revoked due to `invalid_grant`).

The collection schema is `SentEmailInterface` in `src/types/entities.ts`. To wire a real provider later, replace the body of `sendEmail` while keeping its signature and the `sentEmails` audit log so prior sends remain queryable.

## Data Access Layer

All DAOs extend `AbstractDAO<T>`, a generic MongoDB wrapper providing:

- `findOne`, `findArray`, `findSequence` (async generator)
- `insertOne/Many`, `updateOne/Many`, `deleteOne/Many`
- `bulkWrite`, `aggregateArray/Sequence`
- `findByOwnerAndId(entityId, userId)` — scoped reads
- `replaceById(entityId, doc)` — upsert by `_id`

DAOs are initialized as singletons in `loadDataAccess()` before the server starts.

### Collections & Indexes

| DAO | Collection | Key Indexes |
|---|---|---|
| ItemsDAO | `items` | `user`, `user+status`, `user+expectedBy`, `user+timeStart`, `user+updatedTs`, `user+externalId` (unique sparse, public-API dedupe), `user+status+contentHash+createdTs` (public-API content dedupe) |
| OperationsDAO | `operations` | `user+ts`, `user+entityType+entityId+ts` |
| ApiTokensDAO | `apiTokens` | `tokenHash` (unique), `user` |
| RoutinesDAO | `routines` | `user`, `user+updatedTs` |
| PeopleDAO | `people` | `user`, `user+updatedTs` |
| WorkContextsDAO | `workContexts` | `user`, `user+updatedTs` |
| DeviceSyncStateDAO | `deviceSyncState` | `user` |
| PushSubscriptionsDAO | `pushSubscriptions` | `user` |
| CalendarIntegrationsDAO | `calendarIntegrations` | `user`, `user+provider` (unique) |
| CalendarSyncConfigsDAO | `calendarSyncConfigs` | `user`, `integrationId+calendarId` (unique), `webhookChannelId` |

## Environment Variables

```bash
# Database
MONGO_DB_URL=mongodb+srv://user:pass@cluster/...
MONGO_DB_NAME=gtd

# Server
PORT=4000
NODE_ENV=production|development|test

# Better Auth
BETTER_AUTH_URL=https://api.getting-things-done.app   # public base URL
BETTER_AUTH_SECRET=<64+ char random string>
CLIENT_URL=https://getting-things-done.app             # trusted CORS origin

# Google OAuth
GOOGLE_OAUTH_APP_CLIENT_ID=...
GOOGLE_OAUTH_APP_CLIENT_SECRET=...

# GitHub OAuth
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Calendar Integration
CALENDAR_ENCRYPTION_KEY=<128 hex chars>       # AES-256 key for token encryption
CALENDAR_WEBHOOK_URL=https://...              # public URL for Google push notifications
CALENDAR_WEBHOOK_CRON_SECRET=<random string>

# Web Push (VAPID)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

**Dev defaults** (applied when `NODE_ENV !== 'production'`):
- `BETTER_AUTH_SECRET` — dev placeholder
- `BETTER_AUTH_URL` — `http://localhost:4000`
- `CLIENT_URL` — `http://localhost:4173`
- `CALENDAR_ENCRYPTION_KEY` — zeros (insecure, dev only)
- Web Push keys — optional; warnings if missing

## Testing

**Framework:** Vitest with a dedicated `gtd_test` MongoDB database.

```bash
npm test                          # all tests
npx vitest run src/tests/sync.test.ts   # single file
```

Tests run sequentially (`fileParallelism: false`) because they share MongoDB collections. Each test clears all collections in `beforeEach`.

**Test utilities** (`tests/helpers.ts`):
- `oauthLogin(app, provider)` — simulates OAuth flow with mocked JWT
- `authenticatedRequest(app, cookie, method, path, body)` — makes requests with session cookie

## Deployment

- **Runtime:** Google Cloud Run (Node 24 Alpine)
- **Build:** Multi-stage Dockerfile — builder compiles TS, runtime copies `build/` + production deps only
- **Exposed port:** 8080 (Cloud Run default)
- **Trigger:** Push to `staging` or `production` branch, or manual via `./scripts/deploy.sh api staging|production`
- **Images:** Pushed to Google Artifact Registry

## Scripts

One-shot maintenance scripts live in `src/scripts/`. Run them via `tsx`, against the same `.env` the server uses.

### Import from FacileThings (`importFacileThings.ts`)

Imports a FacileThings XML export directly into MongoDB for a single user. Writes nothing through the API — connects via `loadDataAccess()` and upserts items by `(user, externalId)` so re-runs replace rows in place rather than duplicating.

```bash
cd api-server
npx tsx --env-file=.env src/scripts/importFacileThings.ts \
  --email <user-email> \
  --file /path/to/facilethings_export.xml \
  [--dry-run]
```

**What gets imported.** Items only. Routines, people, and work contexts are skipped — the script doesn't try to reconstruct them. Hashtags and `@mentions` stay inline in titles.

**Bucket → status mapping.**

| FacileThings list | App status |
|---|---|
| Inbox | `inbox` |
| Next Actions | `nextAction` |
| Tickler File | `nextAction` with `ignoreBefore = reminder` |
| Waiting For | `waitingFor` |
| Calendar / Someday/Maybe / Reference Material | `somedayMaybe` |
| Done | `done` |

**Caveats.**
- Only Done items completed in the last 18 months are kept (older ones are dropped).
- Calendar items lose their `timeStart` and collapse into `somedayMaybe`; the original reminder is preserved in the notes footer. The script never creates GCal-linked items.
- Every imported item's `createdTs` is the import time. Original FacileThings dates (reminder, doneAt, list, project, area, goal, priority, energy, time) are appended to notes under `— Imported from FacileThings —`.
- Idempotent: re-running with the same XML upserts on `externalId = "ft:<index>"` rather than duplicating.

**Use `--dry-run`** to print the planned counts (items per status, skipped older Done items) without writing.

## Gotchas

- **SSE is single-process:** The connection registry is in-memory. Scaling to multiple instances requires a shared pub/sub layer (e.g. Redis).
- **`skipLibCheck: true`** in tsconfig — required because Better Auth's `.d.mts` files have unresolved Bun/Cloudflare/Zod type dependencies.
- **`noPropertyAccessFromIndexSignature`** — add new env vars to `src/env.d.ts` to use dot notation on `process.env`. Never use bracket notation.
- **Calendar pushback is fire-and-forget** — errors are logged but never block the sync response. Check server logs if calendar events aren't syncing.
- **Operation purging** — once ops are purged, a device that hasn't synced must use `/sync/bootstrap` instead of `/sync/pull`. The server handles this transparently.
- **Token encryption key rotation** — changing `CALENDAR_ENCRYPTION_KEY` invalidates all stored OAuth tokens. Users would need to re-authorize their calendar integrations.
