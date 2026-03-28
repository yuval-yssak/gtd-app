# Client Architecture

## Router Context

TanStack Router is used with file-based routing. The router context carries only the IndexedDB instance — created once in `main.tsx` and injected at router level so every route can read/write IDB without prop-drilling.

```ts
// types/routerContext.ts
interface RouterContext {
    db: IDBPDatabase<MyDB>;
}
```

`App.tsx` creates the router as a module-level singleton (inside the module, not inside the component — recreating it on render would reset all router state) and passes `db` as the context value:

```ts
const router = createRouter({ routeTree, context: { db: null as unknown as IDBPDatabase<MyDB> } });

export default function App({ db }: Props) {
    return <RouterProvider router={router} context={{ db }} />;
}
```

Inside any route, access the db via `Route.useRouteContext()`.

## App Data Context

`contexts/AppDataContext.tsx` is the shared-state layer for authenticated routes. It holds the current account and all entity lists read from IndexedDB.

```ts
interface AppData {
    account: StoredAccount | null;
    items: StoredItem[];
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    refreshItems: () => Promise<void>;
    refreshWorkContexts: () => Promise<void>;
    refreshPeople: () => Promise<void>;
}
```

`_authenticated.tsx` owns this context. It initialises state from IDB on mount (`loadAll()`), then syncs with the server (`syncAndRefresh()`). Child routes consume it via the `useAppData()` hook.

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

Database name: `gtd-app`. Defined in `db/indexedDB.ts`, typed via `types/MyDB.ts`.

| Store | Key | Index | Purpose |
|---|---|---|---|
| `accounts` | `id` (UUID) | `email` (unique) | All OAuth accounts ever used on this device |
| `activeAccount` | `'active'` (singleton) | — | Reference to the current account |
| `items` | `_id` (UUID) | `userId` | GTD tasks |
| `routines` | `_id` (UUID) | `userId` | Recurring task templates |
| `people` | `_id` (UUID) | `userId` | Contacts |
| `workContexts` | `_id` (UUID) | `userId` | Context tags |
| `syncOperations` | auto-increment | — | Offline mutation queue |
| `deviceSyncState` | `'local'` (singleton) | — | Device ID + last sync cursor (`lastSyncedTs`) |

All entity stores index by `userId` so a single IDB database can hold data for multiple OAuth accounts simultaneously.

## Sync Architecture

### Bootstrap (first-run)

When `_authenticated.tsx` mounts and `deviceSyncState` does not exist, `bootstrapFromServer()` runs:

1. `GET /sync/bootstrap` → server returns full snapshots of all entities
2. Bulk-insert into IDB stores (items, routines, people, workContexts)
3. Write `deviceSyncState` with `lastSyncedTs = serverTs`

After bootstrap, incremental pulls start from `lastSyncedTs`, so no old ops are replayed.

### SSE (real-time tab updates)

`db/sseClient.ts` holds a module-level `EventSource` singleton. `_authenticated.tsx` opens it when the device is online and closes it on unmount or offline.

When another device pushes a change to the server, the server broadcasts an SSE message. The client's listener calls `syncAndRefresh()`:
1. `flushSyncQueue()` — sends any locally queued ops first
2. `pullFromServer()` — fetches ops newer than `lastSyncedTs`, applies to IDB (last-write-wins on `updatedTs`)
3. `refreshItems()` / `refreshPeople()` / etc. — re-reads IDB → React state

EventSource reconnects automatically on error.

### Push Notifications (background sync)

`db/pushSubscription.ts` registers a Web Push subscription so the Service Worker can receive server notifications even when the app tab is closed.

1. On mount (and when online), fetch VAPID public key from `GET /sync/config`
2. Call `PushManager.subscribe()` with the VAPID key
3. `POST /push/subscribe` with the push endpoint + stable device ID
4. Server stores subscription; on any push, broadcasts a Web Push notification
5. `sw.ts` Service Worker intercepts the `push` event and calls `pullFromServer(db)` to update IDB in the background

Degrades gracefully — returns early if the browser lacks Service Worker or PushManager support.

### Offline Sync Queue

Every mutation immediately writes to IDB and appends a `SyncOperation`:

```ts
interface SyncOperation {
    id?: number;          // auto-increment
    entityType: 'item' | 'routine' | 'person' | 'workContext';
    entityId: string;
    opType: 'create' | 'update' | 'delete';
    queuedAt: string;     // ISO datetime — replay order
    snapshot: StoredEntity | null;  // full state; null for delete
}
```

Before flushing, `flushSyncQueue()` collapses redundant ops per entity:

| Sequence | Result |
|---|---|
| create → update | merged into a single create with final snapshot |
| create → delete | both dropped (entity never reached server) |
| update → delete | single delete |

`POST /sync/push` sends the collapsed ops. Ops are removed from IDB only on a successful response.

`flushSyncQueue()` is called:
- In `_authenticated.tsx` on mount and on every `online` event
- From the Service Worker `sync` event (Background Sync API — Chrome/Edge only)

## `_authenticated.tsx` Boot Sequence

This layout route is the central orchestrator for all authenticated state.

**`beforeLoad`** (runs before render):
- Calls `fetchSessionSafely()` (wraps `authClient.getSession()`)
- If offline and device has a cached account → allow through (offline access)
- If online but no session → redirect to `/login`

**`useEffect` on mount**:
1. `loadAll()` — reads items, workContexts, people from IDB and sets React state (instant, no network)
2. If online: `syncAndRefresh()` — flush queue, bootstrap if needed, pull new ops, refresh state
3. Open SSE connection
4. Register push subscription

**Provides:**
- `AppDataContext` to all child routes
- `Outlet` inside MUI layout (sidebar nav + mobile AppBar)

## Directory Map

```
client/src/
├── main.tsx                     # opens IDB, mounts dev tools in dev, renders App
├── App.tsx                      # creates TanStack Router, injects db context
├── sw.ts                        # Service Worker: background sync + push handler
├── routes/
│   ├── __root.tsx               # root layout: MUI baseline, Outlet, router devtools
│   ├── _authenticated.tsx        # protected layout: session guard, data boot, SSE
│   ├── _authenticated/          # all app screens (inbox, next-actions, calendar, …)
│   ├── login.tsx
│   └── auth.callback.tsx        # writes account to IDB after OAuth redirect
├── contexts/
│   └── AppDataContext.tsx        # shared state: account, items, people, workContexts
├── db/
│   ├── indexedDB.ts             # IDB schema + openAppDB()
│   ├── deviceId.ts              # getOrCreateDeviceId(), sync cursor helpers
│   ├── syncHelpers.ts           # bootstrapFromServer, pullFromServer, flushSyncQueue, queueSyncOp
│   ├── sseClient.ts             # EventSource singleton + openSseConnection()
│   ├── pushSubscription.ts       # Web Push registration
│   ├── item{Helpers,Mutations}.ts
│   ├── person{Helpers,Mutations}.ts
│   ├── routine{Helpers,Mutations}.ts
│   ├── workContext{Helpers,Mutations}.ts
│   ├── accountHelpers.ts        # upsertAccount, setActiveAccount, getActiveAccount
│   └── devTools.ts              # window.__gtd harness (dev + test)
├── hooks/
│   ├── useOnline.ts             # navigator.onLine + online/offline events
│   ├── useAccounts.ts           # multi-account switcher logic
│   └── useRoutines.ts
├── components/                  # shared UI: AppNav, AccountSwitcher, ClarifyDialog, …
├── types/
│   ├── MyDB.ts                  # IDB schema types (Stored* interfaces)
│   └── routerContext.ts         # RouterContext interface
├── lib/
│   └── authClient.ts            # Better Auth browser client
└── constants/
    └── globals.ts               # API_SERVER URL
```
