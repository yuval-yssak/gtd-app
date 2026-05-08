# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server with tsx watch (hot reload) on port 4000
npm run build        # Compile TypeScript to build/
npm start            # Run compiled server (production)
npm run test         # Run Vitest tests
npm run typecheck    # tsc --noEmit
npm run lint         # Biome lint check
npm run lint:fix     # Auto-fix lint + format (Biome)
```

Run a single test file: `npx vitest run src/tests/auth.test.ts`

## Architecture

### Request Lifecycle
`index.ts` calls `loadDataAccess()` (connects MongoDB, inits DAOs, creates `auth`) → starts `@hono/node-server` on `process.env.PORT` (default 4000).

The Hono app is built directly in `index.ts` (no separate `app.ts`). `AppType` is exported from `index.ts` for Hono RPC client type-safety.

### DAO Pattern
`abstractDAO.ts` is a generic MongoDB wrapper. `ItemsDAO` extends it and is exported as a **singleton**. It must have `.init(db)` called once (done in `loaders/mainLoader.ts`) before use. `ItemsDAO` indexes on `user`, `user+status`, `user+expectedBy`, `user+timeStart`.

`UsersDAO` no longer exists — Better Auth manages users natively in its own MongoDB collections (`user`, `session`, `account`, `verification`).

### Auth

Two parallel auth modes share the same user identity space.

**Better Auth (cookie sessions)** — first-party client + dev tooling.
- Implementation: `src/auth/betterAuth.ts`. `createAuth(db)` runs in `loadDataAccess()` and the result is exported as a live ESM binding (`auth`) from `mainLoader.ts`.
- All OAuth routes go to Better Auth: `GET|POST /auth/*` → `auth.handler(c.req.raw)` in `index.ts`.
- Providers: Google and GitHub OAuth. Accounts with the same email are linked automatically to one user.
- Session: Stored in MongoDB (`session` collection). HTTP-only cookie `better-auth.session_token`.
- Middleware: `authenticateRequest` (`src/auth/middleware.ts`) calls `auth.api.getSession({ headers: c.req.raw.headers })` and attaches `session` to the Hono context via `c.set('session', session)`. Read with `c.get('session').user.id` — a string UUID (not `ObjectId`).

**Bearer tokens (`gtd_<random>`)** — public `/v1/*` API used by external integrations and the local MCP server.
- Issuance: `issueApiToken(userId, label, scopes?)` in `src/auth/apiTokens.ts`. Plaintext is shown to the caller exactly once; only the sha256 hash is persisted in the `apiTokens` collection.
- Resolution: `resolveBearerToken(authorizationHeader)` looks up by `tokenHash` and rejects revoked rows.
- Middleware: `authenticateBearer` (`src/auth/bearerMiddleware.ts`) parses `Authorization: Bearer gtd_<…>` and sets `c.var.apiAuth = { userId, tokenId, scopes }`. Bumps `lastUsedTs` fire-and-forget. On failed auth, consumes from the IP-keyed anon rate-limit bucket so a flood of bad credentials cannot exhaust tokenHash lookups.
- Production token-mint UI lives at `Settings → Personal API tokens`. Per-user cap of 20 active tokens. For local dev, `POST /dev/api-tokens` (gated by `NODE_ENV !== 'production'`) is the convenience shortcut.
- **Scopes**: `items.capture`, `items.read`, `items.clarify`, `webhooks.manage`. Default-mint is `[items.capture, items.read]`. Pre-scopes tokens are lazily backfilled on first authenticated use.

> ⚠️ **Do not add an in-process token cache** in `apiTokens.ts` or `bearerMiddleware.ts` without
> also wiring an invalidation channel (SSE/Redis pub-sub). Revocation today goes straight to
> Mongo; the next request that authenticates re-reads the row, so `DELETE /account/tokens/:id`
> propagates within milliseconds. A cache without invalidation lets revoked tokens linger,
> and on multi-instance deploys the divergence is unbounded.

A user identified by Better Auth and a user identified by a bearer token resolve to the same `user.id` — both auth paths converge on Better Auth's UUIDs.

### Adding New Routes
1. Create a router in `src/routes/<feature>.ts`
2. Register it in `index.ts` with `.route('/feature', featureRouter)` on the Hono app

Currently mounted:
- `/sync` — offline-first batch sync (the first-party client's only mutation surface — see "Sync Architecture")
- `/v1` — public REST API (`routes/v1/`); bearer-auth, idempotent create + list/search + complete. Documented in `docs/PUBLIC_API.md`. Reuses `recordOperation` + SSE/web-push/GCal pushback so public-API writes flow through the same fan-out as `/sync`.
- `/push` — web push subscriptions
- `/devices` — device-side session list (which accounts a device hosts)
- `/calendar` — Google Calendar OAuth + management
- `/auth/*` — Better Auth handler
- `/dev` — dev-only login/reset/token-mint, mounted only when `NODE_ENV !== 'production'`

When adding a new route under `/v1/*`, mount `authenticateBearer` via `.use('*', authenticateBearer)` on the sub-router and read `c.var.apiAuth.userId` instead of `c.get('session').user.id`.

## Environment Variables (`.env`)

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

## TypeScript

**`noPropertyAccessFromIndexSignature`** — satisfy this rule via explicit property declarations in a `.d.ts` file, not bracket notation. For `process.env`, add the variable to `src/env.d.ts` and access it with dot notation (`process.env.MY_VAR`). See `src/env.d.ts` for the existing pattern.

## Key Types

- `ItemInterface` (`src/types/entities.ts`) — `status` is `inbox | nextAction | calendar | waitingFor | somedayMaybe | done | trash`; `user` is a `string` UUID (Better Auth ID, not `ObjectId`); optional GTD fields (`workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `ignoreBefore`, `timeStart`, `timeEnd`) vary by status. Public-API-only fields: `externalId` (caller dedupe key, sparse-unique on `(user, externalId)`) and `contentHash` (sha256 of `${title}\n${notes}` for 24h content-dedupe — internal, never returned via the public API).
- `ApiTokenInterface` (`src/types/entities.ts`) — `apiTokens` collection. Stores sha256 `tokenHash` (unique), `user`, `label`, `createdTs`, optional `lastUsedTs`/`revokedTs`. The plaintext token is never persisted.
- `AuthVariables` (`src/types/authTypes.ts`) — Hono context variables `{ session: Session }` for typed `c.get('session')` on cookie-authenticated routes.
- `BearerVariables` (`src/auth/bearerMiddleware.ts`) — `{ apiAuth: { userId, tokenId } }` for typed `c.var.apiAuth` on bearer-authenticated routes.
- `Session` — inferred from Better Auth via `Auth['$Infer']['Session']`.

## Public API conventions (`/v1/*`)

Mutation flow is intentionally identical to `/sync/push` so a single notification fan-out covers both:

1. Persist the entity (`itemsDAO.insertOne` / `replaceById`).
2. `recordOperation(userId, { ..., deviceId: 'api:<tokenId>' })` — server-originated op with the token's pseudo-device id, so other devices learn about the change on their next pull. The `api:` prefix distinguishes public-API writes from the existing `'server'` marker (calendar webhook, routine generator) without polluting the real `deviceSyncState` table.
3. `notifyChange(op, tokenId)` — fans out to SSE (live tabs), web push (closed tabs), and GCal pushback (best-effort, fire-and-forget).

Idempotency:
- `externalId` provided → strict, enforced by sparse-unique partial index `(user, externalId)`. The `POST /v1/items` handler catches E11000 from concurrent inserts and returns the race-winner with `X-Idempotent-Replay: true`.
- `externalId` omitted → best-effort: 24h content-hash lookup. No unique index (one would block legitimate recurring captures). Documented in `docs/PUBLIC_API.md`.

Public response shape:
- `presentItem` (`routes/v1/projections/item.ts`) is an **allowlist** projection — internal sync-anchor fields (`contentHash`, `lastPushedToGCalTs`, `lastSyncedFromGCalTs`, `lastSyncedNotes`) must never leak. When you add a new public field, extend `PUBLIC_FIELDS`; when you add a new internal field, do nothing — the allowlist hides it by default.
