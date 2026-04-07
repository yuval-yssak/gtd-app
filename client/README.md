# GTD Client

Frontend for the [Getting Things Done](https://gettingthingsdone.com/) productivity app. Built with **React 19**, **TypeScript**, **Vite**, and **Material UI**. Designed as an **offline-first PWA** — all data lives in IndexedDB and syncs to the server when online.

## Quick Start

```bash
npm install
npm run dev            # Vite dev server on http://localhost:4173
```

The API server must be running on port 4000 (Vite proxies `/auth`, `/sync`, `/push` requests to it).

## Commands

```bash
npm run dev                        # Vite dev server with HMR
npm run build                      # tsc + vite build (production)
npm run preview                    # preview production build locally
npm run test                       # run Vitest tests
npm run test:coverage              # tests with v8 coverage report
npm run lint                       # Biome lint check
npm run lint:fix                   # auto-fix lint + format
npm run typecheck                  # tsc -b --noEmit
npm run generate-typed-css-modules # regenerate .d.ts files for CSS Modules
npm run storybook                  # Storybook on http://localhost:6006
npm run build-storybook            # static Storybook build
```

## Architecture

### Offline-First Design

The client works fully offline. The data flow is:

1. **All reads** come from IndexedDB (instant, no network)
2. **All writes** go to IndexedDB first, then queue a `SyncOperation` for later upload
3. **Sync** happens opportunistically — on mount, on `online` events, via SSE, or via Web Push

The server is never the source of truth during a session — IndexedDB is. The server reconciles across devices using last-write-wins on `updatedTs`.

### Directory Layout

```
src/
├── main.tsx                         # Opens IDB, mounts dev tools, renders App
├── App.tsx                          # Module-level TanStack Router singleton, injects db context
├── index.css                        # Global CSS: variables, scrollbar, responsive font scaling
├── serviceWorker.ts                 # SW: precaching, background sync, Web Push handler
├── routes/
│   ├── __root.tsx                   # Root layout: MUI theme, CssVarsProvider
│   ├── _authenticated.tsx           # Protected layout: session guard, data boot, SSE, sync
│   ├── -authenticatedRouteGuard.tsx # beforeLoad: checks cached account, verifies session
│   ├── login.tsx                    # OAuth sign-in page
│   ├── auth.callback.tsx            # OAuth callback: writes account to IDB, redirects home
│   └── _authenticated/             # 13 app screens (inbox, next-actions, calendar, etc.)
├── contexts/
│   └── AppDataProvider.tsx          # Shared state: account, items, workContexts, people, routines
├── components/                      # 30+ components with .stories.tsx companions
│   ├── AppNav.tsx                   # Desktop sidebar + mobile bottom nav
│   ├── ClarifyDialog.tsx            # GTD inbox clarification dialog
│   ├── EditNextActionDialog.tsx     # Next action editor
│   ├── StatusBar.tsx                # Sync status indicator
│   ├── clarify/                     # Clarification form field components
│   ├── routines/                    # Routine management components
│   └── settings/                    # Settings components (calendar integrations, etc.)
├── db/                              # IndexedDB + sync layer
│   ├── indexedDB.ts                 # DB schema (v2) + openAppDB()
│   ├── syncHelpers.ts               # bootstrap, pullFromServer, flushSyncQueue, queueSyncOp
│   ├── deviceId.ts                  # getOrCreateDeviceId(), sync cursor helpers
│   ├── sseClient.ts                 # EventSource singleton for real-time updates
│   ├── pushSubscription.ts          # Web Push registration
│   ├── devTools.ts                  # window.__gtd debugging harness (dev + test)
│   ├── item{Helpers,Mutations}.ts   # Item CRUD + query helpers
│   ├── routine{Helpers,Mutations}.ts
│   ├── person{Helpers,Mutations}.ts
│   └── workContext{Helpers,Mutations}.ts
├── api/
│   ├── syncClient.ts                # fetch wrappers for /sync/*, /push/*
│   ├── syncClient.mock.ts           # vi.fn() instances (test mock)
│   └── calendarApi.ts               # Calendar integration API calls
├── hooks/
│   ├── useOnline.ts                 # useSyncExternalStore for online/offline
│   ├── useAccounts.ts               # Multi-account switcher logic
│   ├── useRoutines.ts               # Routine management hook
│   ├── useCalendarOptions.ts        # Calendar dropdown options
│   └── useSwipeGesture.ts           # Touch swipe handling
├── lib/
│   ├── authClient.ts                # Better Auth browser client
│   ├── rruleUtils.ts                # RFC 5545 RRULE parsing helpers
│   ├── clarifyMode.ts               # GTD clarification state machine
│   └── typeUtils.ts                 # hasAtLeastOne, NonEmptyString, etc.
├── types/
│   ├── MyDB.ts                      # IDB schema types (Stored* interfaces)
│   └── routerContext.ts             # RouterContext { db }
├── constants/
│   └── globals.ts                   # API_SERVER URL (from VITE_API_SERVER env var)
├── tests/                           # Vitest unit tests
│   ├── setup.ts                     # fake-indexeddb + navigator mock
│   ├── openTestDB.ts                # Fresh IDB per test
│   ├── syncQueue.test.ts            # Op coalescing logic
│   ├── syncHelpers.test.ts          # Bootstrap/pull/push tests
│   ├── itemMutations.test.ts        # Item state transitions
│   └── ...
└── test-utils/
    └── storybookMocks.ts            # Mock data for Storybook stories
```

### Routing

Uses **TanStack Router** with file-based routing. Routes are auto-generated from `src/routes/` into `routeTree.gen.ts`.

| Route | Screen |
|---|---|
| `/login` | OAuth sign-in (Google, GitHub) |
| `/auth/callback` | OAuth redirect handler — writes account to IDB |
| `/inbox` | Capture + clarify inbox items |
| `/next-actions` | Filtered by energy, time, and work context |
| `/calendar` | Calendar items + Google Calendar sync |
| `/waiting-for` | Delegated items |
| `/routines` | Recurring task templates |
| `/people` | Contacts |
| `/work-contexts` | Context tags (e.g. "at work", "near a phone") |
| `/tickler` | Items with `ignoreBefore` in the future |
| `/someday` | Backlog |
| `/weekly-review` | GTD weekly review mode |
| `/settings` | Account, calendar integrations |
| `/item/:itemId` | Item detail view |

Routes under `_authenticated/` are protected. The guard checks for a cached account in IDB and verifies the session with the server in the background. Offline users with a cached account are allowed through.

### Router Context

The router carries a single value — the IndexedDB instance:

```ts
interface RouterContext {
    db: IDBPDatabase<MyDB>;
}
```

Created once in `main.tsx`, injected at router creation in `App.tsx`. Every route accesses it via `Route.useRouteContext()`. No prop-drilling.

### App Data Context

`AppDataProvider` (owned by `_authenticated.tsx`) holds all entity lists read from IndexedDB:

```ts
interface AppData {
    account: StoredAccount | null;
    items: StoredItem[];
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    refreshItems: () => Promise<void>;
    // ...
}
```

**Mutation pattern:** routes write to IDB, then call `refreshItems()` to re-read IDB into React state. React state is never written directly — IDB is the single source of truth.

```ts
const { db } = Route.useRouteContext();
const { account, refreshItems } = useAppData();

await collectItem(db, account.id, title);  // writes IDB + queues sync op
await refreshItems();                       // re-reads IDB into React state
```

### Boot Sequence (`_authenticated.tsx`)

1. **`beforeLoad`** — checks for a cached account in IDB. If online and no session, redirects to `/login`. Offline users with a cached account pass through.
2. **`useEffect` on mount:**
   - `loadAll()` — reads items, workContexts, people from IDB (instant)
   - If online: `syncAndRefresh()` — flush queue, bootstrap if needed, pull new ops
   - Opens SSE connection
   - Registers Web Push subscription

## IndexedDB Schema

**Database:** `gtd-app` (version 2)

| Store | Key | Index | Purpose |
|---|---|---|---|
| `accounts` | `id` (UUID) | `email` (unique) | All OAuth accounts ever used on this device |
| `activeAccount` | `'active'` (singleton) | — | Reference to current session |
| `items` | `_id` (UUID) | `userId` | GTD tasks |
| `routines` | `_id` (UUID) | `userId` | Recurring task templates |
| `people` | `_id` (UUID) | `userId` | Contacts |
| `workContexts` | `_id` (UUID) | `userId` | Context tags |
| `syncOperations` | auto-increment | — | Offline mutation queue |
| `deviceSyncState` | `'local'` (singleton) | — | Device ID + last sync cursor |

All entity stores index by `userId` so a single database supports multiple OAuth accounts on the same device.

## Sync Architecture

### Three Sync Channels

1. **Sync Queue** — every mutation queues a `SyncOperation` in IDB. Flushed to the server when online.
2. **SSE** — `EventSource` listens for changes from other devices. Triggers `syncAndRefresh()`.
3. **Web Push** — Service Worker receives push notifications when the tab is closed, pulls updates into IDB in the background.

### Offline Queue Coalescing

Before flushing, redundant operations for the same entity are collapsed:

| Sequence | Result |
|---|---|
| create then update | Merged into single create with final snapshot |
| create then delete | Both dropped (entity never reached server) |
| update then delete | Single delete |

### Concurrency Guards

Two module-level flags prevent duplicate network calls:

- `flushInFlight` — prevents overlapping `POST /sync/push` calls
- `pullInFlight` — prevents race conditions on `setLastSyncedTs`

These are necessary because SSE callbacks and Service Worker sync events can fire concurrently.

### Bootstrap (First Run)

When `deviceSyncState` doesn't exist in IDB:

1. `GET /sync/bootstrap` returns full snapshots of all entities
2. Bulk-insert into IDB
3. Write `deviceSyncState` with `lastSyncedTs = serverTs`

After bootstrap, only incremental pulls happen.

## Service Worker & PWA

The app is a PWA using `vite-plugin-pwa` with the `injectManifest` strategy (Workbox).

**What the Service Worker does:**
- **Precaching** — all built assets are cached for offline use
- **Navigation fallback** — serves cached `index.html` for deep-link routes when offline
- **Background Sync** — flushes the sync queue on connectivity recovery (Chrome/Edge only)
- **Web Push** — receives push events, calls `pullFromServer()` to update IDB, shows a notification
- **Notification click** — focuses the existing tab or opens a new window

**Update behavior:** `registerType: 'autoUpdate'` with `skipWaiting()` + `clientsClaim()`. The new Service Worker activates immediately. Users must reload their tab to pick up the new JS/CSS.

**Known risk:** If a user is offline when the new SW activates, old JS may reference code-split chunk URLs that no longer exist in the new precache. This breaks the page until reload. A `registerType: 'prompt'` with an "Update available" toast would eliminate this.

**Debugging:** DevTools -> Application -> Service Workers -> "Update on reload".

## Styling

- **CSS Modules** for all custom styling. Auto-generated `.d.ts` types via `generate-typed-css-modules`.
- **MUI theme** (`extendTheme` with light + dark color schemes) in `__root.tsx`. Attribute-based selector: `[data-color-scheme="dark"]`.
- **`sx` prop** only for layout-specific overrides on wrapper elements, never for component appearance.
- **No** inline styles, styled-components, Tailwind, or CSS-in-JS.

**CSS Module rules:**
- Always dot notation: `styles.navLink` (never `styles["navLink"]`)
- Use the `classnames` package for combining classes (never `.join(" ")`)

**Responsive breakpoints:**
- `56.25rem` (900px) — desktop/mobile layout switch
- Smaller breakpoints for tiny screens (font scaling in `index.css`)

## Storybook

Every component has a `.stories.tsx` companion file.

```bash
npm run storybook        # dev server on port 6006
npm run build-storybook  # static build
```

**Config (`.storybook/main.ts`):**
- Filters out TanStackRouter and VitePWA plugins (not needed in Storybook context)
- Forces `#api/syncClient` to real implementation to avoid Vitest context leaking into browser

**Addons:** `@storybook/addon-a11y` for accessibility testing.

## Testing

**Framework:** Vitest with `fake-indexeddb` for IDB polyfill.

```bash
npm run test              # all tests
npm run test:coverage     # with v8 coverage
```

**Test setup (`tests/setup.ts`):**
- `fake-indexeddb/auto` polyfills IndexedDB globals
- Navigator mock removes `serviceWorker` to short-circuit SW registration

**Mock pattern:** API mocks use `package.json` import conditions:

```json
"#api/syncClient": {
  "test": "./src/api/syncClient.mock.ts",
  "default": "./src/api/syncClient.ts"
}
```

Tests import via `#api/syncClient`, which resolves to `vi.fn()` instances in test mode. Per-test behavior is configured with `vi.mocked(fn).mockResolvedValueOnce(...)`.

## Build & Deployment

**Vite config (`vite.config.ts`):**
- Plugins: TanStackRouterVite (must be first), React, VitePWA
- Dev proxy: `/auth/*`, `/sync`, `/push` -> `http://localhost:4000` (API server)
- Environment: `VITE_API_SERVER` env var for production API URL

**Hosting:** Static files on Cloudflare Pages. Public directory includes `_headers` (CORS, caching) and `_redirects` (SPA fallback).

## Gotchas

- **No TanStack Query.** Server state is managed manually via explicit `pull`/`push`/`bootstrap` calls + a custom sync queue. The offline-first, last-write-wins model doesn't fit TanStack Query's lifecycle.
- **Router is a module-level singleton.** Created outside the component in `App.tsx` — recreating it on render would reset all router state.
- **IDB is the source of truth during a session.** Never write to React state directly. Write to IDB, then call `refreshItems()` (or similar) to update React.
- **`deviceSyncState` is a singleton** keyed by `'local'`. There's one sync cursor per device, not per account.
- **CSS Module types must be regenerated** after adding/renaming CSS classes: `npm run generate-typed-css-modules`. The post-change checklist runs this automatically.
- **Concurrent sync calls collapse.** The `flushInFlight` and `pullInFlight` guards mean that if SSE and a Service Worker sync event fire simultaneously, only one network call happens. This is intentional.
- **Web Push degrades gracefully.** If the browser doesn't support Service Workers or PushManager, registration returns early without error.
- **Multi-account support** — a single IDB database holds data for all accounts, indexed by `userId`. Switching accounts doesn't clear data; it just changes the active filter.
