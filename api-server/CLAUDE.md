# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server with ts-node-dev (hot reload) on port 4000
npm run build        # Compile TypeScript to build/
npm start            # Run compiled server (production)
npm test             # Run Vitest tests
npm run test:lint    # ESLint check
npm run fix          # Auto-fix lint + prettier
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
Auth is handled by **Better Auth** (`src/auth/betterAuth.ts`). `createAuth(db)` is called in `loadDataAccess()` and exported as a live ESM binding (`auth`) from `mainLoader.ts`.

All OAuth routes are handled by Better Auth: `GET|POST /auth/*` → `auth.handler(c.req.raw)` in `index.ts`.

- **Providers**: Google and GitHub OAuth. Accounts with the same email are linked automatically to one user.
- **Session**: Stored in MongoDB (`session` collection). HTTP-only cookie `better-auth.session_token`.
- **Middleware**: `authenticateRequest` (`src/auth/middleware.ts`) calls `auth.api.getSession({ headers: c.req.raw.headers })` and attaches `session` to the Hono context via `c.set('session', session)`.
- **User ID**: Access on protected routes via `c.get('session').user.id` — a string UUID (not `ObjectId`).

### Adding New Routes
1. Create a router in `src/routes/<feature>.ts`
2. Register it in `index.ts` with `.route('/feature', featureRouter)` on the Hono app

The items router (`src/routes/items.ts`) is active with `POST /items` and `GET /items` handlers.

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

## Key Types

- `ItemInterface` (`src/types/entities.ts`) — `status` is `inbox | nextAction | calendar | waitingFor | done | trash`; `user` is a `string` UUID (Better Auth ID, not `ObjectId`); optional GTD fields (`workContexts`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `timeStart`, `timeEnd`) vary by status
- `AuthVariables` (`src/types/authTypes.ts`) — Hono context variables `{ session: Session }` for typed `c.get('session')`
- `Session` — inferred from Better Auth via `Auth['$Infer']['Session']`
