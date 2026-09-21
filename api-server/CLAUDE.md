# CLAUDE.md

Guidance for the API server. Repo-wide commands, coding standards and the post-change checklist live in the root [`CLAUDE.md`](../CLAUDE.md) — this file adds only what is specific to `api-server/`.

Endpoint-by-endpoint reference, collection/index inventory and the full `.env` list: [`README.md`](README.md). Data model: [`../docs/DATA_MODEL.md`](../docs/DATA_MODEL.md). Public API: [`../docs/PUBLIC_API.md`](../docs/PUBLIC_API.md).

## Commands

Run a single test file: `npx vitest run src/tests/auth.test.ts`

Tests need a local Mongo: `docker run -d --rm --name gtd-test-mongo -p 27017:27017 mongo:8.0`. Do not export staging/prod `MONGO_DB_*` vars into the shell you run tests in — dotenv will not override them and vitest will silently hit the remote DB.

The sync-audit suite is separate and hits a real account: `npm run test:sync-audit:setup` then `npm run test:sync-audit`.

## Architecture

### Request Lifecycle
`index.ts` calls `loadDataAccess()` (connects MongoDB, inits DAOs, creates `auth`) → starts `@hono/node-server` on `process.env.PORT` (default 4000).

The Hono app is built directly in `index.ts` (no separate `app.ts`). `AppType` is exported from `index.ts` for Hono RPC client type-safety.

Cloud Run runs `--max-instances=1` and scales to zero, so **no in-process timers or intervals**. Anything periodic is a Cloud Scheduler job POSTing an endpoint guarded by `requireCronSecret` (`auth/cronSecret.ts`, header `x-cron-secret`, value `CRON_SECRET`).

### DAO Pattern
`abstractDAO.ts` is a generic MongoDB wrapper. One DAO per collection under `src/dataAccess/`, each exported as a **singleton** whose `.init(client, dbName)` is called once in `loaders/mainLoader.ts` before use. Each DAO declares its own indexes in `init`.

`UsersDAO` no longer exists — Better Auth manages users natively in its own MongoDB collections (`user`, `session`, `account`, `verification`).

Unique indexes are created with `partialFilterExpression` where in-app rows legitimately share a null field — `createIndexes` rejects and **crashes boot** if pre-existing data already violates a new unique index.

### Auth

Two parallel auth modes share the same user identity space.

**Better Auth (cookie sessions)** — first-party client + dev tooling.
- Implementation: `src/auth/betterAuth.ts`. `createAuth(db)` runs in `loadDataAccess()` and the result is exported as a live ESM binding (`auth`) from `mainLoader.ts`.
- All OAuth routes go to Better Auth: `GET|POST /auth/*` → `auth.handler(c.req.raw)` in `index.ts`.
- Providers: Google and GitHub OAuth. Accounts with the same email are linked automatically to one user.
- Session: stored in MongoDB (`session` collection). HTTP-only cookie `better-auth.session_token`.
- Middleware: `authenticateRequest` (`src/auth/middleware.ts`) calls `auth.api.getSession({ headers: c.req.raw.headers })` and attaches `session` to the Hono context via `c.set('session', session)`. Read with `c.get('session').user.id` — a string UUID (not `ObjectId`).

**Bearer tokens (`gtd_<random>`)** — public `/v1/*` API used by external integrations and the MCP server.
- Issuance: `issueApiToken(userId, label, scopes?)` in `src/auth/apiTokens.ts`. Plaintext is shown to the caller exactly once; only the sha256 hash is persisted in the `apiTokens` collection.
- Resolution: `resolveBearerToken(authorizationHeader)` looks up by `tokenHash` and rejects revoked rows.
- Middleware: `authenticateBearer` (`src/auth/bearerMiddleware.ts`) parses `Authorization: Bearer gtd_<…>` and sets `c.var.apiAuth = { userId, tokenId, scopes }`. Bumps `lastUsedTs` fire-and-forget. On failed auth, consumes from the IP-keyed anon rate-limit bucket so a flood of bad credentials cannot exhaust tokenHash lookups.
- Production token-mint UI lives at `Settings → Personal API tokens`. Cap of `PROD_TOKEN_CAP_PER_USER` (20) active tokens; dev's `POST /dev/api-tokens` has its own higher cap (50) — **the two caps are deliberately not a shared constant**.
- **Scopes** (`ApiTokenScope` in `types/entities.ts`): `items.capture|read|write`, `routines.read|write`, `people.read|write`, `contexts.read|write`, `reassign`, `reassign.accept`, `webhooks.manage`, `claude.assist`. Default-mint is `DEFAULT_API_TOKEN_SCOPES` = `[items.capture, items.read]`. Pre-scopes tokens are lazily backfilled on first authenticated use.

Some routes are dual-auth (`authenticateBearerOrSession`) — the Claude-assist and brief-generate endpoints, reached both by the SPA's cookie and by bearer callers.

> ⚠️ **Do not add an in-process token cache** in `apiTokens.ts` or `bearerMiddleware.ts` without
> also wiring an invalidation channel (SSE/Redis pub-sub). Revocation today goes straight to
> Mongo; the next request that authenticates re-reads the row, so `DELETE /account/tokens/:id`
> propagates within milliseconds. A cache without invalidation lets revoked tokens linger,
> and on multi-instance deploys the divergence is unbounded.

A user identified by Better Auth and a user identified by a bearer token resolve to the same `user.id` — both auth paths converge on Better Auth's UUIDs.

### CORS

Three per-router profiles in `src/auth/corsProfiles.ts`, applied per-route rather than globally — pick deliberately when mounting a new router:
- `strictCors()` — cookie-authenticated routes. Origin pinned to `clientUrl` in production, `credentials: true`.
- `publicCors()` — bearer-only `/v1/*`. `origin: '*'`, `credentials: false` (the bearer token is the auth gate).
- `assistCors()` — credentialed `/v1` routes (Claude-assist, brief generate). Origin pinned to `clientUrl`; a wildcard is illegal alongside credentials and would let a malicious origin ride the victim's `sameSite: 'none'` session cookie.

### Adding New Routes
1. Create a router in `src/routes/<feature>.ts`
2. Register it in `index.ts` with `.route('/feature', featureRouter)` plus the right CORS profile

Currently mounted:
- `/sync` — offline-first batch sync (the first-party client's only mutation surface — see "Sync Architecture")
- `/v1` — public REST API (`routes/v1/`); bearer-auth, idempotent create + list/search + composites + reassign + batch. Documented in `../docs/PUBLIC_API.md`. Reuses `recordOperation` + SSE/web-push/GCal pushback so public-API writes flow through the same fan-out as `/sync`.
- `/v1/claude` — Lane A Claude-assist (propose/apply); mounted **before** the `/v1/*` catch-all so its `assistCors` + logger win
- `/v1/items/:id/brief/generate` — on-demand brief generation; likewise mounted before the catch-all
- `/v1/webhooks` — outbound webhook subscriptions
- `/push` — web push subscriptions
- `/devices` — device-side session list (which accounts a device hosts) + device management
- `/maintenance` — session- or cron-authed repair/purge endpoints (op-log purge + dedup, GCal relink/heal, brief sweep)
- `/calendar` — Google Calendar OAuth + management + webhook receiver/renewal
- `/account/tokens` — personal API token mint/list/revoke UI backend
- `/mcp` + `/mcp-oauth` — remote MCP transport and its OAuth 2.1 authorization server
- `/auth/*` — Better Auth handler
- `/dev` — dev-only login/reset/token-mint, mounted only when `NODE_ENV !== 'production'`

**Mount order matters on `/v1`.** Hono's `.use('/v1/*', …)` is a catch-all; a sub-router needing its own CORS or auth profile must be mounted before it.

When adding a new route under `/v1/*`, mount `authenticateBearer` via `.use('*', authenticateBearer)` on the sub-router and read `c.var.apiAuth.userId` instead of `c.get('session').user.id`.

`DELETE /dev/reset` with `{ emails: [] }` scopes deletion to those users; **without a body it wipes the entire dev database.** The e2e helper `resetServerForEmails` always sends the scoped form.

## Environment Variables (`.env`)

Required to boot:

```
MONGO_DB_URL=
MONGO_DB_NAME=
GOOGLE_OAUTH_APP_CLIENT_ID=
GOOGLE_OAUTH_APP_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
BETTER_AUTH_URL=http://localhost:4000
BETTER_AUTH_SECRET=
CLIENT_URL=http://localhost:4173
PORT=4000
```

Every supported variable is declared with a doc comment in `src/env.d.ts` — that file is the inventory (calendar encryption + webhooks, `CRON_SECRET`, VAPID, `ANTHROPIC_API_KEY`, the `BRIEF_*` flags, the `MCP_OAUTH_*` settings). `README.md` § Environment Variables groups them for operators.

## TypeScript

**`noPropertyAccessFromIndexSignature`** — satisfy this rule via explicit property declarations in a `.d.ts` file, not bracket notation. For `process.env`, add the variable to `src/env.d.ts` and access it with dot notation (`process.env.MY_VAR`). See `src/env.d.ts` for the existing pattern.

## Key Types

Entity interfaces and their fields live in `src/types/entities.ts` and are documented in `../docs/DATA_MODEL.md`. The context/auth types worth knowing:

- `AuthVariables` (`src/types/authTypes.ts`) — Hono context variables `{ session: Session }` for typed `c.get('session')` on cookie-authenticated routes.
- `BearerVariables` (`src/auth/bearerMiddleware.ts`) — `{ apiAuth: { userId, tokenId, scopes } }` for typed `c.var.apiAuth` on bearer-authenticated routes.
- `Session` — inferred from Better Auth via `Auth['$Infer']['Session']`.

`ItemInterface.user` is a `string` UUID (Better Auth id, **not** `ObjectId`), and the owner field on `items` is `user` — not `userId`. Querying by `userId` silently returns 0 rows; verify the owner field per collection.

Public-API-only item fields: `externalId` (caller dedupe key, sparse-unique on `(user, externalId)`) and `contentHash` (sha256 of `${title}\n${notes}` for 24h content-dedupe — internal, never returned via the public API).

## Public API conventions (`/v1/*`)

Mutation flow is intentionally identical to `/sync/push` so a single notification fan-out covers both:

1. Persist the entity (`itemsDAO.insertOne` / `replaceById`).
2. `recordOperation(userId, { ..., deviceId: 'api:<tokenId>' })` — server-originated op with the token's pseudo-device id, so other devices learn about the change on their next pull. The `api:` prefix distinguishes public-API writes from the existing `'server'` marker (calendar webhook, routine generator, brief writer) without polluting the real `deviceSyncState` table.
3. `notifyChange(op, tokenId)` — fans out to SSE (live tabs), web push (closed tabs), and GCal pushback (best-effort, fire-and-forget).

Idempotency:
- `externalId` provided → strict, enforced by sparse-unique partial index `(user, externalId)`. The `POST /v1/items` handler catches E11000 from concurrent inserts and returns the race-winner with `X-Idempotent-Replay: true`.
- `externalId` omitted → best-effort: 24h content-hash lookup. No unique index (one would block legitimate recurring captures). Documented in `../docs/PUBLIC_API.md`.

Public response shape:
- `presentItem` (`routes/v1/projections/item.ts`) is an **allowlist** projection — internal sync-anchor fields (`contentHash`, `lastPushedToGCalTs`, `lastSyncedFromGCalTs`, `lastSyncedNotes`) must never leak. When you add a new public field, extend `PUBLIC_FIELDS`; when you add a new internal field, do nothing — the allowlist hides it by default.

## Operations log

Op snapshot schemas in `src/schemas/operations/` must be a **strict superset** of the corresponding entity interface. A schema narrower than the interface 400s the whole `/sync/push` batch and permanently jams the originating client's push queue until the schema is widened.

Op identity is stamped at insert time, not at handler entry — a run-start timestamp makes late ops look stale and lets a pull cursor skip them.
