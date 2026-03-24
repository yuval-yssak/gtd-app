# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack GTD (Getting Things Done) productivity app — monorepo with:
- `api-server/` — Node.js/Hono/TypeScript backend on port 4000
- `client/` — React/TypeScript/Vite frontend on port 4173

## Commands

### API Server (`cd api-server`)
```bash
npm run dev          # Start dev server with ts-node-dev (hot reload)
npm run build        # Compile TypeScript to build/
npm run test         # Run Vitest tests
npm run test:lint    # ESLint check
npm run fix          # Auto-fix lint + prettier
```

### Client (`cd client`)
```bash
npm run dev          # Vite dev server
npm run build        # tsc + vite build
npm run lint         # ESLint check
npm run preview      # Preview production build
```

## Architecture

### Auth Flow
Better Auth — Google and GitHub OAuth. Accounts with matching emails are linked to one user. Session stored in MongoDB; HTTP-only cookie `better-auth.session_token`. Client tracks login state in IndexedDB (`localLoggedIn` store) rather than React state.

### Offline-First Design
The client is PWA-capable with a Service Worker. All items are stored in **IndexedDB** (via `idb`) with a `syncOperations` store for queueing changes when offline. The router context passes `db`, `auth`, and `items` to all routes.

### Routing
Uses `@tanstack/react-router` with file-based routing under `client/src/routes/`. Routes under `_authenticated/` are protected. Root layout is in `__root.tsx`.

### Data Access (API)
`abstractDAO.ts` wraps MongoDB — `ItemsDAO` extends it and is initialized in `loaders/mainLoader.ts` as a singleton. Better Auth owns the `user` collection; `UsersDAO` no longer exists.

### Key Types
- **Item** (`GTD task`): categories are `inbox | nextAction | calendar | waitingFor | done | trash`, with optional GTD fields like `workContexts`, `energy`, `time`, `focus`, `urgent`
- **IndexedDB schema**: `MyDB` type in `client/src/types/MyDB.ts`

### Backend Entry Points
- `api-server/src/index.ts` — builds Hono app, starts server, loads DB and auth

### Frontend Entry Points
- `client/src/main.tsx` — initializes IndexedDB, renders app
- `client/src/App.tsx` — sets up router context

## Code Style
- Prettier: 160-char line width, 4-space indent (tabs)
- TypeScript strict mode enabled
- Production API CORS origin: `https://getting-things.done.app`
