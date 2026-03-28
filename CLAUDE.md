# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack GTD (Getting Things Done) productivity app — monorepo with:
- `api-server/` — Node.js/Hono/TypeScript backend on port 4000
- `client/` — React 19/TypeScript/Vite frontend on port 4173

Full data model reference: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)

### GTD Workflow Phases

| Phase | Description |
|---|---|
| **Collect** | Capture anything into the inbox without judgement |
| **Clarify** | Process each inbox item: trash it, complete it, schedule it, delegate it, or turn it into a `nextAction` with metadata |
| **Review** | Scan all buckets regularly (quick daily scan + deep weekly review) |
| **Do** | Filter `nextAction` items by available energy, time, and work context |

## Commands

### API Server (`cd api-server`)
```bash
npm run dev          # Start dev server with tsx watch (hot reload)
npm run build        # Compile TypeScript to build/
npm run test         # Run Vitest tests
npm run lint         # Biome lint check
npm run lint:fix     # Auto-fix lint + format (Biome)
npm run typecheck    # tsc --noEmit
```

### Client (`cd client`)
```bash
npm run dev          # Vite dev server
npm run build        # tsc + vite build
npm run lint         # Biome lint check
npm run lint:fix     # Auto-fix lint + format (Biome)
npm run typecheck    # tsc -b --noEmit
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

All server-side interfaces live in `api-server/src/types/entities.ts`. Client-side mirrors (prefixed `Stored*`) live in `client/src/types/MyDB.ts`.

| Entity | Collection | Purpose |
|---|---|---|
| `ItemInterface` | `items` | Core GTD task. Status drives which optional fields apply. |
| `RoutineInterface` | `routines` | Recurring task template. Generates `nextAction` items on a schedule. |
| `PersonInterface` | `people` | Named contact. Referenced by `peopleIds` and `waitingForPersonId` on items. |
| `WorkContextInterface` | `workContexts` | Condition tag (e.g. "near a phone"). Referenced by `workContextIds` on items. |
| `OperationInterface` | `operations` | Server-side sync log entry. Stores full entity snapshot per change. |
| `DeviceSyncStateInterface` | `deviceSyncState` | Per-device sync cursor. Drives operation log purging. |
| `CalendarIntegrationInterface` | `calendarIntegrations` | OAuth credentials + calendar ID for Google Calendar sync. |

**Item status → relevant fields:**
- `inbox` — title only
- `nextAction` — `workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `ignoreBefore`
- `calendar` — `timeStart`, `timeEnd`, `calendarEventId`, `calendarIntegrationId`
- `waitingFor` — `waitingForPersonId`, `peopleIds`, `expectedBy`, `ignoreBefore`
- `done` / `trash` — no additional fields

**Tickler pattern:** `ignoreBefore` (ISO date) on a `nextAction` or `waitingFor` item hides it from all lists until that date. Separate from calendar `timeStart` to avoid semantic overloading.

### Sync Architecture

All mutations are recorded as `OperationInterface` documents on the server. Each operation stores the **full entity snapshot** at the time of the change (not a diff), making last-write-wins conflict resolution trivial: the operation with the latest `ts` wins.

Client-side flow:
1. Change written to IndexedDB → `SyncOperation` queued with `entityType`, `entityId`, `opType`, and snapshot
2. On reconnect → `flushSyncQueue()` replays ops to the server in `queuedAt` order
3. Device pulls new ops from server since its `lastSyncedTs` and applies them locally

**Purge rule:** operations older than `min(lastSyncedTs)` across all of a user's devices are safe to delete.

All entities carry `updatedTs` (ISO datetime) as the conflict-resolution anchor. Client IDs are stable UUIDs generated on first launch (`deviceId` in `DeviceSyncStateInterface`).

### Calendar Integration

`CalendarIntegrationInterface` holds OAuth credentials (encrypted at rest) and a target `calendarId` for a Google Calendar account.

- **Items:** a `calendar` item linked to Google Calendar carries `calendarEventId` + `calendarIntegrationId`. Changes sync bidirectionally.
- **Routines:** a `fixedSchedule` routine can own or attach to a Google Calendar recurring event series via `calendarEventId`. The app can either create a new series or import an existing one.

### Backend Entry Points
- `api-server/src/index.ts` — builds Hono app, starts server, loads DB and auth

### Frontend Entry Points
- `client/src/main.tsx` — initializes IndexedDB, renders app
- `client/src/App.tsx` — sets up router context

## Code Style
- Biome: 160-char line width, 4-space indent, single quotes
- TypeScript strict mode enabled
- Production API CORS origin: `https://getting-things.done.app`

## Coding Standards

### Comments

Whenever making a code change that is not immediately obvious — e.g. a workaround, a non-obvious prop or flag, a subtle timing dependency, or a browser-specific fix — add a concise inline comment explaining why it is needed. One to three lines is usually enough. Skip comments where the code is self-evident.

### File Naming

- Non-component files (hooks, utilities, scripts, etc.): **camelCase** (e.g., `useSomething.tsx`, `myUtil.ts`)
- Component files: **PascalCase** matching the component name (e.g., `MyComponent.tsx`)

### TypeScript
- No `any`. Use `unknown` when the type is genuinely unknown.
- Prefer narrowly inferred types; avoid explicit annotations where inference is accurate.
- Use generics, mapped types, conditional types, and template literal types where they produce more accurate and reusable types than `as` casts.
- Type assertions (`as`) must be rare and justified.

### Functions
- ≤ 5 meaningful actions per function, typically ~5 lines.
- Single level of abstraction per function — if a function orchestrates, it calls named helpers; it does not contain inline implementation details.
- In functions longer than 4 lines, always wrap `return` or `continue` after a condition in curly braces for scannability. In functions of 4 lines or fewer, a single-line form is acceptable:
  ```ts
  // Good — longer function
  if (condition) {
      return;
  }
  // OK — short function (≤ 4 lines)
  if (condition) return;
  ```

### Arguments
- 1–2 arguments preferred; 3 is borderline; 4+ is a violation.
- If arguments are grouped into an object, it must represent a meaningful domain concept, not an arbitrary bag of params.

### Naming
- Names must convey intent precisely. Avoid vague names (`data`, `item`, `temp`, `handle`, `process`).
- Boolean variables/functions must read as predicates: `isLoading`, `hasError`, `canSubmit`.
- Event handlers must describe what happened, not the implementation: `onUserSelected` not `handleClick`.

### Mutability
- `const` everywhere. `let` requires justification. `var` is prohibited.
- If a `let` exists, evaluate whether the mutation can be eliminated by extracting a function or simplifying the logic.

### Abstraction
- A function must operate at a single level of abstraction. When a function mixes levels (orchestration alongside low-level implementation details), extract the lower-level concerns into named helpers.
- Any repeated pattern appearing 2+ times must be extracted to a named abstraction.
- Pagination/streaming → async generator functions.
- Rate-limiting/debouncing → a decorator/wrapper function, not inline logic.

### Functional Programming
- Prefer pure functions, immutability, and function composition over imperative mutation.
- Prefer declarative array methods (`filter`, `map`, `flatMap`, `reduce`) over imperative `for`/`forEach` loops that push into a mutable accumulator. A loop that builds up an array by pushing is a signal to reach for `map`/`flatMap` instead.

### Patterns
- Identify where established patterns (factory, strategy, decorator, observer, repository) would reduce complexity or improve extensibility.
- Flag anti-patterns: god functions, boolean traps, deeply nested conditionals, primitive obsession.

### Dates
- Use `dayjs` for all date parsing, formatting, manipulation, duration arithmetic, and timestamp comparisons. Do not use the native `Date` API or other date libraries.

### CSS / Styling
- Use CSS Modules for all custom styling. No inline styles, no `styled-components`, no Tailwind, no other CSS-in-JS.
- MUI components are styled via the centralized MUI theme — use `sx` props only for layout-specific overrides on wrapper elements, not for component appearance.
- Global CSS variables go in `client/src/index.css`.

## Running Locally

```bash
# Terminal 1 — API server (port 4000)
cd api-server && npm run dev

# Terminal 2 — Frontend (port 4173)
cd client && npm run dev
```

## Deployment

### Environments

| Environment | App URL | API URL |
|---|---|---|
| production | https://getting-things-done.app | https://api.getting-things-done.app |
| staging | https://staging.getting-things-done.app | https://api-staging.getting-things-done.app |

### How to Deploy

- **Push-triggered**: push to the `staging` or `production` branch when `api-server/**` changes → auto-runs `.github/workflows/deploy-api.yml`
- **Manual**: `./scripts/deploy.sh api staging|production` — triggers the same workflow via `gh workflow run`
- Track progress: https://github.com/yuval-yssak/gtd-app/actions/workflows/deploy-api.yml

### GitHub Environments

Configured at https://github.com/yuval-yssak/gtd-app/settings/environments — two environments (`production`, `staging`), each holding its own GCP secrets and vars.

### Infrastructure

- **Backend**: Google Cloud Run — `gtd-api` (production) and `gtd-api-staging` (staging), region `us-central1`
- **API proxy**: Cloudflare Worker (`workers/api-proxy/`) routes `api.getting-things-done.app` and `api-staging.getting-things-done.app` to the respective Cloud Run service
- **Docker images**: built from `api-server/Dockerfile` and pushed to Google Artifact Registry

### Service Worker (PWA)

The client is a PWA using `vite-plugin-pwa` with Workbox (`registerType: 'autoUpdate'` in `client/vite.config.ts`). On each build, Workbox generates a new precache manifest with hashed filenames.

When a new version is deployed, `vite-plugin-pwa` injects `skipWaiting()` + `clientsClaim()` into the generated `sw.js`, so the new SW activates immediately and takes over all open tabs. **Users need to reload their tab once** to start running the new JS/CSS.

**Known risk (offline edge case):** if a user is offline when the new SW activates, the old JS may try to lazy-load code-split chunks whose hashed URLs are no longer in the new precache, resulting in a broken page until they reload. This is an inherent risk of `skipWaiting` in an offline-first app.

**Recommended improvement:** switch to `registerType: 'prompt'` with a custom "Update available — reload?" toast. This delays SW activation until the user acknowledges, eliminating the mid-session breakage risk.

For development/debugging: DevTools → Application → Service Workers → "Update on reload".
