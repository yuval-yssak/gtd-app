# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server with ts-node-dev (hot reload) on port 4000
npm run build        # Compile TypeScript to build/
npm start            # Run compiled server (production)
npm test             # Run Jest tests
npm run test:lint    # ESLint check
npm run fix          # Auto-fix lint + prettier
```

Run a single test file: `npx jest path/to/test.spec.ts`

## Architecture

### Request Lifecycle
`index.ts` calls `loadDataAccess()` (connects MongoDB, inits DAOs) → starts Express on `process.env.PORT` (default 4000).

`app.ts` middleware order: CORS → `express.json()` → `cookie-parser` → routes.

### DAO Pattern
`abstractDAO.ts` is a generic MongoDB wrapper. `UsersDAO` and `ItemsDAO` extend it and are exported as **singletons**. Each must have `.init(db)` called once (done in `loaders/mainLoader.ts`) before use. `UsersDAO` indexes on `email`; `ItemsDAO` indexes on `user`, `user+status`, `user+expectedBy`, `user+timeStart`.

### Auth
Google OAuth 2.0 flow lives in `src/api/auth/google.ts`. On success, a JWT is signed and stored in an HTTP-only secure cookie (`jwtTokens`). JWT payload shape: `{ contents: UserPayload[] }` — an array to support future multi-user tokens, currently always length 1.

`authenticateRequest` middleware (`src/auth/middleware.ts`) verifies the cookie and attaches `req.users` (typed as `RequestWithUsers`). Use this middleware on any protected route.

### Adding New Routes
1. Create a router in `src/api/<feature>.ts`
2. Register it in `app.ts` (e.g. `app.use('/feature', featureRouter)`)

The items router (`src/api/items.ts`) is fully implemented with POST and GET handlers but is **commented out** in `app.ts` — uncomment to activate.

## Environment Variables (`.env`)

```
MONGO_DB_URL=
MONGO_DB_NAME=
GOOGLE_OAUTH_APP_CLIENT_ID=
GOOGLE_OAUTH_APP_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
JWT_SECRET=
PORT=4000
```

## Key Types

- `ItemInterface` (`src/types/entities.ts`) — `status` is `inbox | nextAction | calendar | waitingFor | done | trash`; optional GTD fields (`workContexts`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `timeStart`, `timeEnd`) vary by status
- `RequestWithUsers` (`src/types/authTypes.ts`) — Express `Request` extended with `users: UsersPayload`
