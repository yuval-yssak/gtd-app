# Client Architecture

Repo-wide commands, coding standards and the post-change checklist live in the root [`CLAUDE.md`](../CLAUDE.md) — this file adds only what is specific to `client/`.

## Router Context

TanStack Router is used with file-based routing. The router context carries only the IndexedDB instance — created once in `main.tsx` and injected at router level so every route can read/write IDB without prop-drilling.

```ts
// types/routerContext.ts
interface RouterContext {
    db: IDBPDatabase<MyDB>;
}
```

`App.tsx` creates the router as a module-level singleton (inside the module, not inside the component — recreating it on render would reset all router state) and passes `db` as the context value. Inside any route, access the db via `Route.useRouteContext()`.

## App Data Context

`contexts/AppDataProvider.tsx` is the shared-state layer for authenticated routes, owned by `_authenticated.tsx` and consumed via the `useAppData()` hook. It holds the active account, the logged-in account list, and every synced entity list read from IndexedDB — `items`, `workContexts`, `people`, `routines`, `reviewInboxes`, `itemBriefs` — each with a `refresh*()` and an `all*` variant.

**The `all*` lists are cross-account; the unprefixed lists are scoped to visible accounts.** Multiple OAuth accounts live in one IDB database at once, so pick deliberately: a list view wants the scoped list, a lookup by id may need the `all*` one.

`withActiveAccountSession` / `withOwnerSession` pin the API-origin Better Auth session to the right account for the duration of a task. **The app's active account lives in IDB, while the API origin has its own session cookie; they can diverge.** Any call that must act as a specific user has to go through these wrappers, or it silently runs as whoever the cookie says.

**Mutation pattern in routes:**
```ts
const { db } = Route.useRouteContext();
const { account, items, refreshItems } = useAppData();

await collectItem(db, account.id, title);  // writes IDB + queues sync op
await refreshItems();                       // re-reads IDB → React state
```

Routes never write directly to React state — they write to IDB and call a refresh. This keeps IDB as the single source of truth.

## Note on TanStack Query

This project does **not** use TanStack Query. Server state is managed manually:
- All data lives in IndexedDB, not in a query cache.
- Fetches happen explicitly (`pullFromServer`, `bootstrapFromServer`, `flushSyncQueue`).
- Real-time updates come via SSE and push notifications (see below).

The offline-first, last-write-wins model doesn't fit TanStack Query's server-state lifecycle, so a custom sync queue is used instead.

## IndexedDB Schema

Database name: `gtd-app`. Schema and upgrade path in `db/indexedDB.ts`, typed via `types/MyDB.ts` — read those for the current version and store list rather than trusting a copy here.

Shape: `accounts` (keyed by account `id`, unique `email` index) and the singleton `activeAccount` hold auth state; every synced entity store (`items`, `routines`, `people`, `workContexts`, `reviewInboxes`, `itemBriefs`) is keyed by `_id` and **indexed by `userId`**, so one database holds several OAuth accounts at once; `syncOperations` (auto-increment) is the offline mutation queue; `deviceMeta` / `syncCursors` / `drafts` are device-local.

**Adding a synced entity means a schema bump plus a `case` arm in `db/syncHelpers.ts`** — the default branch warns and skips, so a missing arm silently drops those ops.

**Adding any store that holds user rows also means adding it to `wipeUserData` in `db/accountHelpers.ts`** (the per-account wipe used by sign-out AND by account evaporation after a server-side deletion) **and to the local snapshot in `db/exportRecoveryData.ts`.** Nothing enforces this on the client — the server-side inventory (`api-server/src/lib/userDataInventory.ts`) is the enforced half; keep the two in step. Generated content (briefs) counts: it must be wiped with the account.

**Always open through `withAppDB`, never a bare long-lived `openAppDB`.** A connection left open holds the schema version and blocks the next upgrade in every other tab — a v7→v8 upgrade deadlocked on a stale tab and rendered a blank page with no error. The Service Worker outlives individual events, so this matters most there.

## API Client

All `fetch()` calls live in `src/api/`. Files with a test seam have a paired `.mock.ts` companion and a `"imports"` alias in `package.json`:

| Alias | Module | Mock |
|---|---|---|
| `#api/syncClient` | `src/api/syncClient.ts` | `src/api/syncClient.mock.ts` |
| `#api/syncApi` | `src/api/syncApi.ts` | `src/api/syncApi.mock.ts` |
| `#api/assistApi` | `src/api/assistApi.ts` | `src/api/assistApi.mock.ts` |

```json
"#api/syncClient": {
    "test": "./src/api/syncClient.mock.ts",
    "default": "./src/api/syncClient.ts"
}
```

In test files, `vi.mock` intercepts the alias before imports run:
```ts
vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
import { fetchSyncOps } from '#api/syncClient'; // gets vi.fn() from mock
```

The mock companion exports `vi.fn()` instances. Tests configure per-test behaviour with `vi.mocked(fetchSyncOps).mockResolvedValueOnce(...)` and reset call history with `vi.clearAllMocks()` in `afterEach`.

## Sync Architecture

### Bootstrap (first-run)

When `_authenticated.tsx` mounts and no sync cursor exists for the account, `bootstrapFromServer()` runs:

1. `GET /sync/bootstrap` → server returns full snapshots of all entities
2. Bulk-insert into IDB stores
3. Write the sync cursor from the snapshot's high-water mark

After bootstrap, incremental pulls start from that cursor, so no old ops are replayed. The cursor must come from the snapshot's high-water mark, **not from "now"** — a concurrent server-side import writing ops at an earlier `ts` would otherwise never be pulled, leaving rows in the DB that the app never shows.

### SSE (real-time tab updates)

`db/sseClient.ts` holds a module-level `EventSource` singleton. `_authenticated.tsx` opens it when the device is online and closes it on unmount or offline.

When another device pushes a change to the server, the server broadcasts an SSE message. The client's listener calls `syncAndRefresh()`:
1. `flushSyncQueue()` — sends any locally queued ops first
2. `pullFromServer()` — fetches ops newer than the cursor, applies to IDB (last-write-wins on `updatedTs`; a losing item snapshot still hands its server-owned calendar fields to the newer local row — same owner, same event only; `db/calendarLinkMerge.ts`)
3. `refreshItems()` / `refreshPeople()` / etc. — re-reads IDB → React state

EventSource reconnects automatically on error. **Be careful adding per-message refetches** — an SSE fan-out that triggers a per-tab pull that triggers another fetch has previously burned the Cloudflare Worker free-tier daily request limit from the user's own open tabs alone.

### Account deletion (evaporation)

A deleted account must vanish from every device, including one offline for a year. Three signals, all ending in `db/evaporateUser.ts`:

- **Tombstone probe** — `multiUserSync.ts` asks `GET /auth/user-status` (via `#api/accountApi`) for every logged-in account before the per-user loop, throttled to once per 10 minutes per account (every request is billed through the Cloudflare Worker); a dead session (401, or no multi-session entry) forces the probe. Any non-200 is `unknown` and never evaporates (fail-open).
- **SSE `account-deleted`** — `sseClient.ts` closes the channel and hands the id to the provider.
- **Cross-tab broadcast** — a `storage` event (`contexts/accountEvaporatedEvents.ts`), sent only AFTER the survivor's IDB pointer and session cookie are written, so a tab that reloads on it boots onto a coherent state.

Rules that came out of review: never evaporate inside a sync pass (IDB's active pointer is then the account being synced — collect the deleted ids and evaporate after the session restore); every "leave this account" reload goes through `reloadDestination` (`/` while another account remains, else `/login`) so two tabs racing each other agree; `navigator.serviceWorker.ready` never settles without an active worker, so the push unsubscribe is gated on notification permission and bounded. Settings → "Your data" (`components/settings/AccountDataSection.tsx`) runs delete/export through `withActiveAccountSession` and sends `expectedUserId` so a drifted cookie can never delete the wrong account.

### Push Notifications (background sync)

`db/pushSubscription.ts` registers a Web Push subscription so the Service Worker can receive server notifications even when the app tab is closed.

1. On mount (and when online), fetch VAPID public key from `GET /sync/config`
2. Call `PushManager.subscribe()` with the VAPID key
3. `POST /push/subscribe` with the push endpoint + stable device ID
4. Server stores subscription; on any push, broadcasts a Web Push notification
5. `serviceWorker.ts` intercepts the `push` event and pulls in the background (`db/backgroundSync.ts`)

Degrades gracefully — returns early if the browser lacks Service Worker or PushManager support.

### Offline Sync Queue

Every mutation immediately writes to IDB and appends a `SyncOperation` (`types/MyDB.ts`) carrying `userId`, `entityType`, `entityId`, `opType`, `queuedAt` (ISO, replay order) and the full `snapshot` (`null` for a delete). `userId` is required so a multi-account flush can fan out per user without cross-account leakage.

Before flushing, `flushSyncQueue()` collapses redundant ops per entity:

| Sequence | Result |
|---|---|
| create → update | merged into a single create with final snapshot |
| create → delete | both dropped (entity never reached server) |
| update → delete | single delete |

`POST /sync/push` sends the collapsed ops. Ops are removed from IDB only on a successful response. A server-side 400 on any op in the batch jams the queue permanently — see the op-schema warning in the root `CLAUDE.md`.

`flushSyncQueue()` is called:
- In `_authenticated.tsx` on mount and on every `online` event
- From the Service Worker `sync` event (Background Sync API — Chrome/Edge only)

**Cross-context flush lock.** Every context's flush serializes on the `gtd-sync-flush` Web Lock (`db/crossContextLock.ts`): a flush that finds another tab or the Service Worker mid-push **waits** (bounded, `PUSH_TIMEOUT_MS` + 15s) and then drains whatever is left, so a fire-and-forget dispatch from `queueSyncOp` is never silently dropped. The IDB `deviceMeta.flushingTs` marker is only the fallback for browsers without Web Locks — it cannot wait, so it skips while held and self-heals after 30s. `pushSyncOps` carries a 60s deadline (`api/syncPushLimits.ts`) so a hung request cannot pin the lock until Cloudflare's 100s origin timeout (the 2026-10-03 "Mark done pushed ~100s late" incident); batches are capped at `PUSH_BATCH_MAX` ops because `/sync/push` has no idempotency key — an aborted request the server still applied is re-inserted on retry, so the deadline must never race a slow-but-progressing push. Known window: a flush awaited inside `withSessionGate` can outlive the gate's 10s timeout while waiting for the lock; if another pass pivots the cookie meanwhile, the late push hits the server's misroute guard (400, ops stay queued, next trigger retries). `flushInFlight` is keyed per `userIdFilter` so a waiting flush for one account is never handed to another account's pass.

## `_authenticated.tsx` Boot Sequence

This layout route is the central orchestrator for all authenticated state.

**`beforeLoad`** → `authenticatedRouteGuard` (`routes/-authenticatedRouteGuard.tsx`), which runs before render:
- Calls `fetchSessionSafely()` (wraps `authClient.getSession()`, tolerating a network error)
- If offline and device has a cached account → allow through (offline access)
- If online but no session → redirect to `/login`

**On mount**:
1. Reads entities from IDB and seeds React state (instant, no network)
2. If online: `syncAndRefresh()` — flush queue, bootstrap if needed, pull new ops, refresh state
3. Open SSE connection
4. Register push subscription

**Provides:** `AppDataProvider` to all child routes, and `Outlet` inside the MUI layout (sidebar nav + mobile AppBar).

Note that `AppNav` double-mounts, so state that must survive a remount (e.g. the reauth banner) belongs in a module-level store, not component state.

## Directory Orientation

```
client/src/
├── main.tsx / App.tsx           # opens IDB; creates the router and injects db context
├── serviceWorker.ts             # custom Workbox SW: precache, background sync, push
├── routes/                      # file-based routes; _authenticated/ is the protected app
├── contexts/AppDataProvider.tsx # shared authenticated state
├── data/                        # React 19 cached-promise resources (appResource, …)
├── db/                          # IDB schema + per-entity {Helpers,Mutations} + sync machinery
├── api/                         # every fetch() call, plus .mock.ts test seams
├── hooks/ · lib/ · components/  # React hooks · pure logic · UI
├── types/MyDB.ts                # IDB schema types (Stored* interfaces)
└── constants/globals.ts         # API_SERVER URL
```

Per-entity IDB access is split `<entity>Helpers.ts` (reads) / `<entity>Mutations.ts` (writes that also queue a sync op). Follow that split when adding an entity.

## Coding Standards

### React

- Prefer co-locating state as close as possible to where it is used; only lift state when two sibling components genuinely need to share it.
- Custom hooks are the extraction unit for reusable stateful logic — not utility functions with `use*` names for logic that doesn't touch React state or refs.
- Avoid `useEffect` for derived state; compute it inline or with `useMemo`.
- Never read from a ref during render — refs are for imperative escape hatches, not rendering logic.

### React 19 & Suspense

- React 19 features are first-class: `<Suspense>`, `use()`, `useTransition`, `useOptimistic`, `useActionState`, `useFormStatus`, `useDeferredValue`, `lazy()`, `cache()`. Reach for them before hand-rolled `useState<boolean>` loading flags or `useEffect`-driven async patterns.
- For data reads: write a cached promise (e.g. `data/appResource.ts`, `data/initialAuthBundle.ts`, `prefetchCalendarOptions` in `hooks/useCalendarOptions.ts`) and `use()` it inside the consumer. Two consumers reading the same key share the same promise — that's how Suspense de-dupes. A `use()` reader over a cache that can return `null` will spin: make sure the miss path populates the cache rather than re-throwing every render.
- Wrap consumers in a Suspense boundary at the right granularity: route-level for the whole-page initial read (`_authenticated.tsx` does this for the `AppData` resource), per-section for hooks that suspend a smaller area, and `<AppErrorBoundary>` (mode `'page'` or `'inline'`) outside every Suspense boundary so a thrown rejection has somewhere to land.
- For background refreshes that should not flash a fallback (sync, SSE, push): drop the cache entry and swap the snapshot in inside `startTransition`. The provider in `data/AppResourceProvider.tsx` does this — it registers its `refresh(scope)` through `registerAppResourceRefreshHandler`, and callers fire it via the module-level `triggerAppResourceRefresh` (`data/appResource.ts`) without importing context.
- For mutation pending state: `useTransition` is the default — its `[isPending, startTransition]` replaces the `useState<boolean>` + manual `try/finally` toggle. Keep a `useRef` alongside if you need to dedupe rapid double-submits (transitions don't dedupe).
- Exception: when a mutation surface needs richer state than a single `isPending` boolean — per-action error messages, per-row pending sets, error/recovery UI — keep `useState`. Examples in this codebase: `useAccounts`'s `pendingAction` enum + `actionError`, `PersonalApiTokens`'s `revokingId` + `actionError` alongside its `useTransition`, the `PendingReassignProvider` overlay map.

### Test IDs

- `data-testid` values are camelCase: `inboxItem`, `clarifyButton`
- Prefer `data-testid` over selecting by text or CSS class — text changes break tests, class names are implementation details

### CSS / Styling
- Use CSS Modules for all custom styling. No inline styles, no `styled-components`, no Tailwind, no other CSS-in-JS.
- MUI components are styled via the centralized MUI theme — use `sx` props only for layout-specific overrides on wrapper elements, not for component appearance.
- Global CSS variables go in `client/src/index.css`.
- **Never concatenate classNames with array `.join(" ")`.** Use the `classnames` package instead: `import classNames from "classnames"`.
- **Never use bracket notation for CSS Module classes** (`styles["preview"]`). Use dot notation (`styles.preview`) — `generate-typed-css-modules` ensures all classes are typed and accessible this way.

### Filters

A page's visibility filter (tickler `ignoreBefore`, archived/visible accounts) must be mirrored by anything that stages items for that page — `reviewFlowState` and the Weekly Review staging in particular. A filter applied on the page but not in staging surfaces items the user has explicitly hidden.
