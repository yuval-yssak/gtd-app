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
│   └── constants.ts               # Cookie name constant
├── routes/
│   ├── sync.ts                    # Sync endpoints (bootstrap, push, pull, SSE)
│   ├── push.ts                    # Web Push subscription management
│   ├── calendar.ts                # Google Calendar OAuth + management
│   └── devLogin.ts                # Dev-only login helper (non-production)
├── dataAccess/
│   ├── abstractDAO.ts             # Generic MongoDB wrapper (CRUD, bulk, aggregation)
│   ├── itemsDAO.ts                # Items collection
│   ├── operationsDAO.ts           # Sync operation log
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

### Dev (non-production only)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/dev/login` | Upserts user by email, returns session cookie |
| `DELETE` | `/dev/reset` | Wipes all collections (test cleanup) |

## Authentication

**Better Auth** handles all OAuth and session management.

- **Providers:** Google and GitHub. Accounts with the same email are automatically linked to one user.
- **Session:** Stored in MongoDB (`session` collection). HTTP-only cookie `better-auth.session_token`.
- **Middleware:** `authenticateRequest` calls `auth.api.getSession()`, attaches session to the Hono context.
- **User ID:** Access via `c.get('session').user.id` — a UUID string (not ObjectId).
- **Collections managed by Better Auth:** `user`, `session`, `account`, `verification`.

In production, cookies are `Secure` with `SameSite=none` for cross-domain API access.

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
| ItemsDAO | `items` | `user`, `user+status`, `user+expectedBy`, `user+timeStart`, `user+updatedTs` |
| OperationsDAO | `operations` | `user+ts`, `user+entityType+entityId+ts` |
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

## Gotchas

- **SSE is single-process:** The connection registry is in-memory. Scaling to multiple instances requires a shared pub/sub layer (e.g. Redis).
- **`skipLibCheck: true`** in tsconfig — required because Better Auth's `.d.mts` files have unresolved Bun/Cloudflare/Zod type dependencies.
- **`noPropertyAccessFromIndexSignature`** — add new env vars to `src/env.d.ts` to use dot notation on `process.env`. Never use bracket notation.
- **Calendar pushback is fire-and-forget** — errors are logged but never block the sync response. Check server logs if calendar events aren't syncing.
- **Operation purging** — once ops are purged, a device that hasn't synced must use `/sync/bootstrap` instead of `/sync/pull`. The server handles this transparently.
- **Token encryption key rotation** — changing `CALENDAR_ENCRYPTION_KEY` invalidates all stored OAuth tokens. Users would need to re-authorize their calendar integrations.
