# Scalable bootstrap — Phases 0–1 implementation plan

Status: **draft for approval** (2026-09-02). Design + decisions live in GTD item
`df203e0b-b6e8-46f8-9a36-efd7660b3f25`. Branch: `feat/scalable-bootstrap` off `main`;
Phases 0 + 1 ship together → `staging` → `main`. Each step ends with the repo checklist
green (lint:fix → typecheck → test → reviewer subagent) with unit + Playwright coverage,
and waits for explicit commit approval.

## Decisions this plan is built on

| Topic | Decision |
|---|---|
| Atlas | stays on M0 |
| Client calendar-sync interval | unchanged |
| Sync-loop taming | purge stale device rows + server-side per-user coalescing |
| Windows (Phase 2/3, for reference) | hot set = live + done ≤ 30d + trash ≤ 7d; purge trash at 45d; done never purged |
| Archive (Phase 2) | server-backed + background local mirror of done, 12 months, ~50 MB cap |

## Ground truth that shapes the plan

- **Cloud Run runs `--max-instances=1`** (`.github/workflows/deploy-api.yml`, `docs/gcp-deploy-plan.md` gotchas). In-memory per-process state (`KeyedMutex`, `sseConnections`) is already relied upon, so an in-memory coalescer is correct, not merely acceptable.
- **The Hono app is assembled inline in `api-server/src/index.ts`**; no app factory. Tests build their own `new Hono().route(...)` (see `src/tests/noStoreCache.test.ts`).
- **Node 22.22 / hono 4.12.18 / @hono/node-server 2.0.1 / mongodb 7.1.1.** `hono/compress` uses the global `CompressionStream`; it skips responses that already carry `Content-Encoding`/`Transfer-Encoding`, `text/event-stream`, HEAD, and `Cache-Control: no-transform`. Hono's `c.json()` sets no `Content-Length`, so the size threshold never applies (every JSON body is gzipped; harmless).
- **`@mongodb-js/zstd` is not installed.** The driver lazily requires it and throws `MongoMissingDependencyError` if `compressors` names zstd without it. v7.0.0 ships prebuilt napi binaries for `linuxmusl-x64` (matches `node:22-alpine` in the Dockerfile) and `darwin-arm64`. Local test Mongo `slc-database-1` is `mongo:8.0.26` (zstd supported).
- **Per-user stale-device reaping already exists**: `lib/purgeFloor.ts` (`STALE_DEVICE_DAYS = 30`), `lib/staleDevices.ts` `reapStaleDevices`, called from `routes/sync.ts` `purgeOldOperations()` on every `/sync/pull` and from `POST /maintenance/purge-operations`. "Idle" = both `lastSeenTs` and `lastSyncedTs` older than the cutoff. Device rows never trigger calendar sync; **the 13 POSTs every ~2 min are 13 live clients** (`AppDataProvider.syncAndRefresh` → `syncCalendarIntegrationsForActiveSession` on boot, on `online`, and on every SW `sync-complete`). So item 3 is hygiene; **item 4 is what stops the storm.**
- **Client recovery for a deleted device row already exists**: `/sync/pull` → `409 {bootstrapRequired:true}`; client `syncClient.ts` throws `BootstrapRequiredError` → `syncRecovery.ts` `recoverFromBootstrapRequired`. Covered by `e2e/sync-recovery-reaped-device.spec.ts` and `e2e/device-management.spec.ts` test 3.
- **`withSyncLock`** (`routes/calendar.ts` ~5736–5753): module-level `KeyedMutex` keyed per calendar config, FIFO, in-memory. A concurrent caller **waits then runs its own full sync**. The webhook path has a per-channel running/queued coalescer (`channelStates`); the manual `POST /calendar/integrations/:id/sync` route has none → N devices = N GCal syncs.
- **Cron-secret pattern**: `POST /calendar/webhooks/renew` checks `x-webhook-cron-secret` against `CALENDAR_WEBHOOK_CRON_SECRET` inline (~5901). The e2e api webServer does not set it.

---

# Phase 0 — relief without schema change

Implementation order on the branch: **0.1 gzip → 0.2 coalescing → 0.3 zstd → 0.4 stale-device cron**. Each is one commit (after approval); 0.2 is the storm fix and carries the largest test surface; 0.3 is isolated because it adds a native module.

## 0.1 HTTP gzip on the API

Global `compress()` from `hono/compress`, registered first so it wraps every router and still sees `noStoreCache`'s `Cache-Control: no-store` (not `no-transform`). SSE (`/sync/events`, MCP streams) is excluded by content-type; the Phase 1 stream route sets its own `Content-Encoding` and is skipped.

Beneficiaries: `GET /sync/bootstrap`, `GET /sync/pull`, `GET /calendar/integrations`, `/calendar/all-sync-configs`, `GET /devices`, `/v1/*` lists, `/mcp` JSON.

Files:
- `api-server/src/index.ts` — `import { compress } from 'hono/compress'`; `.use('*', compress())` before `.use('*', noStoreCache())`, with a 2–3 line comment (outermost; SSE excluded by content-type; no Content-Length so threshold is moot).
- `api-server/src/tests/httpCompression.test.ts` (new; topology of `noStoreCache.test.ts`) —
  App A: `compress()` + `noStoreCache()` + `/big` (~50 KB JSON) + `/stream` (`text/event-stream`).
  App B: real `/auth/*` + `/sync` routes over `loadDataAccess('gtd_test')`, seed ~300 items, `GET /sync/bootstrap?deviceId=dev-1`.
  Cases: (a) `accept-encoding: gzip` → `content-encoding: gzip`, no `content-length`, body decodes via `DecompressionStream('gzip')` to the seeded payload; (b) no header → identity; (c) `br` only → identity; (d) SSE never encoded; (e) `Cache-Control: no-store` survives.
- `api-server/CLAUDE.md` request-lifecycle note: gzip is global; streamed routes self-encode or set `Transfer-Encoding`.

Note: `app.fetch()` returns the raw compressed Response; tests decompress explicitly.

## 0.2 Per-user calendar-sync coalescing (the storm fix)

Current flow (`routes/calendar.ts` line ~1299): per request load integration → per enabled config `withSyncLock(syncSingleCalendar)` (GCal timezone + `getExceptions` per routine + incremental/full list) → `renewWebhookIfExpired` → `runOutboundBackfill` → notify → `runMissedPushSweep`. Nothing dedupes concurrent requests.

Design:
- **Key** `${userId}:${integrationId}`. The client POSTs once per integration in parallel (`Promise.allSettled` in `AppDataProvider`), so per-user-only keying would make integration B piggyback on A's result.
- **Layer 1, single-flight**: `Map<key, Promise<Result>>`; concurrent caller awaits the same promise, gets the same body with `coalesced: true`; entry deleted in `finally` (a rejection propagates to all awaiters → they all see the 502).
- **Layer 2, recent-result debounce**: `Map<key, {startedAt, finishedAt, result}>` written on success only. If `now − finishedAt < CALENDAR_SYNC_DEBOUNCE_MS` (default 60 000) **and** `operationsDAO.countOpsAfter(userId, startedAt, '') === 0` → return `{...result, coalesced: true}` without touching Google. GCal-side changes arrive by webhook (bypasses this route), so nothing is lost.
- **Bypass** `?force=1` skips the debounce (still single-flights). Settings "Sync now" sends it; automatic boot/online/push syncs do not.
- **Invalidate** on config/integration mutations: `POST/PATCH/DELETE .../sync-configs`, `PATCH /integrations/:id`, `DELETE /integrations/:id`, OAuth callback (reconnect).
- Multi-instance: per-process state; `--max-instances=1` makes that the whole story. `withSyncLock` stays inside the task and still serialises against webhook syncs.

Files:
- `api-server/src/lib/coalescedRunner.ts` (new) — `class CoalescedRunner<T>` with `run(key, task, { force, isUnchangedSince })` → `{ result, coalesced }`, `invalidate(key)`, `clear()`. Window read per call from `CALENDAR_SYNC_DEBOUNCE_MS` (guarded like `cursorHoldbackSeconds()` in sync.ts). Clock via dayjs.
- `api-server/src/env.d.ts` — `CALENDAR_SYNC_DEBOUNCE_MS?: string` (0 disables).
- `api-server/src/routes/calendar.ts` — extract handler body into `runManualIntegrationSync(integration, userId): Promise<ManualSyncResult>` (404/410 + try/catch→502 stay in the handler); module-level `manualSyncCoalescer`; `manualSyncKey(userId, integrationId)`; handler calls `run(...)` and returns `{...result, coalesced}`; log `[calendar] manual sync coalesced | userId=… integrationId=… reason=inflight|debounce`; `invalidate` in the five mutation handlers; export a `resetManualSyncCoalescerForTests()`.
- `api-server/src/tests/setup.ts` — `process.env.CALENDAR_SYNC_DEBOUNCE_MS = '0'` in global `beforeEach`. **Load-bearing:** many `calendar.test.ts` cases POST sync twice within milliseconds.
- `api-server/src/tests/coalescedRunner.test.ts` (new; pattern of `keyedMutex.test.ts`) — shared invocation; independent keys; rejection clears in-flight and stores no recent entry; debounce hit/miss; `force`; `isUnchangedSince=false`; `invalidate`.
- `api-server/src/tests/calendar.test.ts` — new `describe('POST /calendar/integrations/:id/sync — coalescing')` with window 60 000 in `beforeEach`, `0` in `afterEach`: two concurrent POSTs (deferred `listEventsFull`) → both 200, one GCal call, exactly one `coalesced: true`; sequential within window → coalesced; `?force=1` → 2 calls; op inserted after first run → not coalesced; first run rejects → 502 and the next POST runs fresh, concurrent piggybacker also 502; PATCH a sync-config then POST → not coalesced.
- Client: `client/src/api/calendarApi.ts` `syncIntegration(id, { force? })` appends `?force=1`; `client/src/components/settings/CalendarIntegrations.tsx` `onSyncNow` passes `{ force: true }`; `AppDataProvider` unchanged. Unit test asserting the `force=1` query (extend the existing calendarApi/CalendarIntegrations test or add a fetch-mock test).
- `api-server/CLAUDE.md` — document the coalescing contract and `force`.

## 0.3 Mongo wire compression (zstd)

`compressors: ['zstd']` via `MongoClient` options in code (not the URL): `MONGO_DB_URL` is a GitHub Environment secret in two environments, and driver options override the URI anyway. Env escape hatch `MONGO_WIRE_COMPRESSORS=none`.

Files:
- `api-server/package.json` — `"@mongodb-js/zstd": "^7.0.0"` in `dependencies` (required at runtime once `compressors` is set).
- `api-server/src/env.d.ts` — `MONGO_WIRE_COMPRESSORS?: string` (comma list; default `zstd`; `none` disables).
- `api-server/src/loaders/mainLoader.ts` — split `mongoClientOptions()` into `wireCompressionOptions()` (parse + validate against `zstd|snappy|zlib`) and `testResilienceOptions()` (existing block); `mongoConnect()` spreads both. Add `logNegotiatedCompression(client)` after connect: `db('admin').command({ hello: 1 })` → log `requested=… negotiated=${hello.compression ?? 'none'}`, try/catch so it never blocks boot.
- `api-server/Dockerfile` — no structural change; comment above the `npm install` lines that zstd fetches a `linuxmusl-x64` prebuilt via prebuild-install and fails loudly (no gyp toolchain in alpine) rather than shipping a broken image. Hardening only if the first build fails: `apk add --no-cache python3 make g++` in the builder stage.
- `api-server/src/tests/mongoWireCompression.test.ts` (new) — after `loadDataAccess('gtd_test')`, `admin().command({hello:1}).compression` contains `zstd`; `MONGO_WIRE_COMPRESSORS=none` yields no compressors (export `wireCompressionOptions`); pure parser tests (`'zstd,zlib'`, `'none'`, garbage → default).
- `docs/gcp-deploy-plan.md` gotchas — native module + escape hatch.

## 0.4 Purge stale device rows (global cron)

Value, honestly: per-user reaping already runs on every pull. This adds (a) accounts with no active puller, (b) push-subscription hygiene for fully drained devices (each wasted web push wakes a SW and can cascade into a calendar POST), (c) an observable count. Idle definition stays exactly the existing one, so the cron can never be more aggressive than the pull-time reaper.

Files:
- `api-server/src/auth/cronSecret.ts` (new) — `requireCronSecret()` middleware (`createMiddleware`, like `noStoreCache.ts`): header `x-webhook-cron-secret` vs `CALENDAR_WEBHOOK_CRON_SECRET`, 401 on mismatch/empty. Keep the env name (now the shared scheduler secret) to avoid touching Cloud Run/Scheduler config.
- `api-server/src/routes/calendar.ts` ~5901 — `/webhooks/renew` uses `requireCronSecret()`; existing renew tests keep passing.
- `api-server/src/dataAccess/deviceSyncStateDAO.ts` — `findUsersWithStaleRows(cutoffTs)` via `distinct('user', { lastSeenTs: {$lt}, lastSyncedTs: {$lt} })`; index `{ lastSeenTs: 1, lastSyncedTs: 1 }` in `init()`.
- `api-server/src/lib/opLogPurge.ts` (new) — `purgeOpsBelowFloor(userId)` = `findArray({user}) → computePurgeFloor → deleteOlderThan`; replaces the three copies in `sync.ts purgeOldOperations`, `devices.ts purgeOpsAfterDeviceRemoval`, `maintenance.ts` (behaviour-preserving; existing tests cover).
- `api-server/src/lib/staleDevices.ts` — `reapStaleDevicesForAllUsers(cutoffTs)` → per user `reapStaleDevices` then `purgeOpsBelowFloor`; returns `{ scannedUsers, removedDevices, fullyDrainedDevices, purgedOps }`; sequential (small N, gentle on M0).
- `api-server/src/routes/cron.ts` (new) — `POST /cron/purge-stale-devices` behind `requireCronSecret()`, cutoff `dayjs().subtract(STALE_DEVICE_DAYS,'day')`, one summary log line, returns counts. No in-process timer (would silently delete rows under e2e specs that fabricate aged rows; Cloud Scheduler wakes the instance).
- `api-server/src/index.ts` — `.route('/cron', cronRoutes)` (server-to-server, no CORS profile, like `/calendar/webhooks/*`).
- `api-server/src/routes/devLogin.ts` — `POST /dev/age-device { deviceId, email?, days }` sets both timestamps to `now − days` (dev-only guard as `/dev/reap-device`).
- Tests: `api-server/src/tests/cron.test.ts` (new; scaffold from `devices.test.ts` + renew env try/finally) — 401 without/wrong secret; reaps across two users, leaves fresh rows; keeps stale-`lastSeenTs`/fresh-`lastSyncedTs` row; frees the floor and purges ops; multi-account device keeps push subscription when only one account's row is stale (mirror `maintenance.test.ts` ~149); reaped device's next pull → 409; idempotent second call → zeros. `api-server/src/tests/cronSecret.test.ts` (new, small). Keep green: `sync.test.ts` 1105–1330, `maintenance.test.ts` 117–185, `devices.test.ts` 271–390.
- E2E: `e2e/playwright.config.ts` api webServer gains `CALENDAR_WEBHOOK_CRON_SECRET=e2e-cron-secret`. New `e2e/stale-device-purge.spec.ts`: two devices sync a shared item → `POST /dev/age-device` device 2 (31 d) → `POST /cron/purge-stale-devices` → Settings on device 1 shows one row → device 2 reload → registered again, recovery dialog hidden, item present, post-recovery item round-trips. Move `withTwoLoggedInDevices`, `fetchDeviceCount`, `isDeviceRegisteredOnServer` from `device-management.spec.ts` into `e2e/helpers/devices.ts` rather than duplicating.
- `docs/gcp-deploy-plan.md` — daily Cloud Scheduler job next to the renew job: `gcloud scheduler jobs create http gtd-staging-purge-stale-devices --schedule="17 4 * * *" --uri=https://api-staging.getting-things-done.app/cron/purge-stale-devices --http-method=POST --headers="x-webhook-cron-secret=…"`.

## Phase 0 staging verification (after the Phase 0+1 deploy)

- **gzip**: `curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' https://gtd-api-staging-xi26ftoh4a-uc.a.run.app/version` → `content-encoding: gzip`, no `content-length`; identity without the header; repeat via `https://api-staging.getting-things-done.app` to see what Cloudflare presents; `/sync/bootstrap` with `-w '%{size_download}'` with/without the header (delete the probe device row afterwards).
- **zstd**: `gcloud logging read '… textPayload:"wire compression"' --project gtd-app-project-491308 --limit 3` → `negotiated=zstd`; Atlas network bytes drop at constant request volume.
- **coalescing**: logging filter `"manual sync coalesced"`; count `POST …/sync` before/after; Google Calendar API requests/min ≈ ≤1/min per integration outside forced syncs; "Sync now" produces a non-coalesced line.
- **purge**: `curl -X POST …/cron/purge-stale-devices -H "x-webhook-cron-secret: $SECRET"` → counts; mongosh `deviceSyncState.countDocuments({lastSeenTs:{$lt:c},lastSyncedTs:{$lt:c}})` → 0; Settings → Connected devices shows survivors; then `gcloud scheduler jobs run …`.

## Phase 0 e2e risk register

- **gzip**: Chromium decodes transparently; `page.route(...).continue()` passes encoded bodies through. Smoke: `calendar-sync-chip`, `initial-sync-skeleton`, `multi-device-sync`.
- **zstd**: a failed prebuild download on a dev box breaks `npm run dev` for all e2e; escape hatch `MONGO_WIRE_COMPRESSORS=none`.
- **coalescing** (highest risk): any spec triggering two automatic syncs for one integration within 60 s and expecting the second to import new GCal state through the manual route. Audit says GCal-change specs use `/dev/calendar/simulate-*` (webhook path) and `calendar-sync-chip` throttles client-side, so expected impact is nil. Run all `calendar-*.spec.ts` plus `routine*`/`weekly-review`. Sanctioned fix if one breaks: `CALENDAR_SYNC_DEBOUNCE_MS=0` in the playwright webServer command, not loosening the server logic. Verify `calendar-duplicate-event-guard` still passes (manual run still goes through `withSyncLock`).
- **purge job**: fires only on the cron endpoint; no timer; no cross-spec interference.

---

# Phase 1 — streaming bootstrap

Goal: `GET /sync/bootstrap/stream` (gzip'd NDJSON from Mongo cursors), one pinned cursor acked at the end, chunked client writes outside the session gate, progress chip, IDB v9. No hot-set filter yet (Phase 2).

## Anchors in today's code

- **Server** `api-server/src/routes/sync.ts`: bootstrap handler 193–257. Cursor pin 211–215: `heldBack = cursorHoldbackBoundary()` (97–100, `(now−5s, id:'')`), `bootstrapCursor = existing ahead ? existing : heldBack` (never rewinds). Five parallel `findArray` at 217–223. Device row upsert at 231–254 **before** the response is sent, which is what holds the purge floor for this device. Purge: `purgeOldOperations` 115–126 → `computePurgeFloor` (`lib/purgeFloor.ts` 34–46) → `operationsDAO.deleteOlderThan`; the floor body is duplicated in `routes/maintenance.ts` 42–45.
- `abstractDAO.findSequence` (line 51) is an unused `AsyncGenerator` over the driver cursor; generator `return()` closes the cursor. `countDocuments` at 84.
- Streaming precedent: the SSE route (sync.ts 475–511) returns `new Response(new ReadableStream(...))` and detects disconnect via `c.req.raw.signal`. `hono/streaming` is unused. `@hono/node-server` 2.0.1 aborts the signal on socket close and honours `drain` backpressure. `noStoreCache()` already stamps `no-store` on streamed responses.
- No zod on route bodies today; zod conventions in `schemas/operations/shared.ts` (`isoDateTime`).
- **Client** `client/src/db/syncHelpers.ts`: `bootstrapFromServer` (319–321) = `withSessionGate(bootstrapFromServerUnguarded)`; unguarded body (330–368) = `fetchBootstrap` → `remapUser` → one `withCrossContextLock(SYNC_APPLY_LOCK)` holding `bulkPutItems` + four copy-pasted per-store transactions (348–358) + `setSyncCursor`. Gate 376–429, `sessionGateTimeoutMs = 10_000` (387) self-releases with a warn.
- `client/src/db/multiUserSync.ts`: `syncAllLoggedInUsers` holds the gate for the whole per-user loop (43–61); `pullOrBootstrap` (293–303) bootstraps inside it; `withAccountSession` (108) also takes the gate. `syncRecoveryActions.ts` `bootstrapAndUnlock` (105–115) bootstraps inside `withAccountSession`.
- `itemHelpers.ts` `bulkPutItems` (29–34): one tx, unconditional `put`, no LWW. `crossContextLock.ts`: `navigator.locks`, not reentrant.
- `indexedDB.ts`: `openDB('gtd-app', 8)`; v5 wipe precedent `wipeCachedEntitiesAndSyncState` (155–164); `blocked`/`blocking` (96–110, b65bb78) are version-agnostic → cover 8→9 unchanged.
- `api/syncClient.ts` `fetchBootstrap` (79–95) + `BootstrapPayload`; mock in `syncClient.mock.ts`.
- `isInitialSyncing`: `useState` in `contexts/AppDataProvider.tsx` (154), raised in `loadAll` (384–390), cleared in `syncAndRefresh` finally (290–292) and `runCatchUpPull` (247); read by `AccountSyncChip` + 12 skeleton consumers. `SyncingChip` is an indeterminate spinner. Module-store pattern to copy: `contexts/syncRecoveryStore.ts`.
- Browser support: Vite default target `baseline-widely-available` (Safari 16+); no browserslist. Client vitest env `node`, so `ReadableStream`/`TextDecoder` are native in tests.
- **Infra**: `deploy-api.yml` has no `--timeout` → Cloud Run default 300 s. `workers/api-proxy/src/index.ts` does `return fetch(proxied)` → body passes through as a stream, nothing buffers.

## 1.1 Server streaming route

**Separate `GET /sync/bootstrap/stream`**, not content negotiation: ~25 e2e specs + `e2e/helpers/gtd.ts:266 fetchBootstrap` consume the JSON shape; `page.route('**/sync/bootstrap*')` in `initial-sync-skeleton.spec.ts:37` keeps matching; the JSON route is deleted as a discrete last step.

- `api-server/src/lib/bootstrapCursor.ts` (new) — `resolveBootstrapCursor(deviceId, userId)` lifts sync.ts 211–214; move `cursorHoldbackSeconds`, `cursorHoldbackBoundary`, `isCursorAfter` (79–105) here (pull keeps importing them).
- `api-server/src/lib/bootstrapStream.ts` (new) —
  - `type BootstrapLine = {t:'meta', expected} | {t:EntityType, d:EntitySnapshot} | {t:'keepalive'} | {t:'end', cursor, counts}`. Entity wrapped under `d` (no field collision with `t`; one `remapUser(line.d)` on the client).
  - `async function* bootstrapLines(userId, cursor, signal)` — `meta` from five `countDocuments({user})`; then `person → workContext → routine → reviewInbox → item` via `findSequence({user}, {batchSize: 200})`, checking `signal.aborted` per row; then `end`.
  - `async function* chunkForFlush(lines, {maxRows: 500, maxMs: 250, keepaliveMs: 15_000})` — pure over an `AsyncIterable<string>`; emits `{"t":"keepalive"}` on idle so Cloudflare's 100 s window stays fed if Mongo stalls.
  - `gzipBootstrapBody(chunks, onCancel)` — `Readable.from(chunks).pipe(createGzip({flush: Z_SYNC_FLUSH}))` wrapped in a hand-built `ReadableStream` (`pull` from the gzip async iterator, `cancel` destroys both and calls `onCancel`); per-chunk sync flush costs <1 % ratio. `.pipe` gives backpressure for free.
- `routes/sync.ts` — `.get('/bootstrap/stream', authenticateRequest, …)`: `deviceId` query only (label/timezone move to the ack); `resolveBootstrapCursor` **before** any entity read; if `deviceId`, `bootstrapLeasesDAO.pin(...)` (1.2); abort listener logs `[bootstrap-stream] client disconnected`; `new Response(body, {headers: {'Content-Type': 'application/x-ndjson', 'Content-Encoding': 'gzip', 'X-Accel-Buffering': 'no'}})`. Headers go out before the first Mongo read → TTFB ≈ auth + one lease upsert. Always gzip (the Phase 0 `compress()` middleware skips it because `Content-Encoding` is set). Leave `GET /bootstrap` untouched until step 10.

## 1.2 Cursor pin + ack — and the purge-floor gap (design addition, please confirm)

The old handler wrote the device row *before responding* so that a sibling device's pull could not compute `min(lastSyncedTs)` without this device and purge ops it still needs (sync.ts 225–230). Moving the row write to the ack reopens that gap for the whole stream (minutes for large users): a sibling pulls at T+60 s, the floor jumps past T−5 s, ops in [T−5 s, T+60 s] are purged, and this device's progressively-read snapshot can be stale for an entity whose op is gone. Both "row only on ack" and "abandoned stream never advances the floor" hold if the *hold* lives outside `deviceSyncState`:

- `api-server/src/dataAccess/bootstrapLeasesDAO.ts` (new) — collection `bootstrapLeases`, doc `{_id: deviceSyncStateId(deviceId,userId), deviceId, user, lastSyncedTs, lastSyncedId, expiresTs}` (same cursor field names so `computePurgeFloor` accepts leases unchanged); indexes `{user:1}` and a TTL on a `Date` mirror; `BOOTSTRAP_LEASE_HOURS = 2`; `pin` (replaceOne upsert), `release`, `findActive(userId, now)`. Register in `loaders/mainLoader.ts`; wipe in both `/dev/reset` branches (`devLogin.ts` 226–256) and sync-test `beforeEach`. `BootstrapLeaseInterface` in `types/entities.ts`; `docs/DATA_MODEL.md` + CLAUDE.md table.
- `lib/purgeFloor.ts` — loosen `computePurgeFloor` param to `Pick<…,'lastSyncedTs'|'lastSyncedId'>[]`; add `loadPurgeFloor(userId)` = floor over device rows ∪ active leases; replace the duplicated bodies in sync.ts 119–122 and maintenance.ts 42–45. A lease never raises the floor (min) and never sits below the same device's row (pin = max(existing, heldBack)); an abandoned stream holds the floor only until the lease expires.
- `POST /sync/bootstrap/ack` — `schemas/bootstrapAck.ts`: `z.object({deviceId, userId, cursor:{ts: isoDateTime, id}, deviceLabel?: max 80, timezone?})`. `lib/bootstrapAck.ts` `recordBootstrapAck(userId, ack)`: forward-only conditional upsert (`$or: [{lastSyncedTs: {$lt: ts}}, {lastSyncedTs: ts, lastSyncedId: {$lte: id}}]`, `$set` cursor + `lastSeenTs` + label + `timezoneReportFields`, `upsert: true`); E11000 (row exists and is ahead) caught via `isDuplicateKeyError` → `updateOne({_id}, {$set: lastSeenTs/label/timezone}, {upsert:false})` → `'kept-existing'`. Then `release` the lease. Handler: 400 on zod failure; 400 `user_mismatch` when `ack.userId ≠ session.user.id` (same rationale as the push misroute guard 269–291); 400 `cursor_in_holdback` when the cursor is after `cursorHoldbackBoundary()`. Response `{ok, recorded}`.
- `isDeviceRegistered`, `/device-status`, `/devices`, `reapStaleDevices` unchanged: a device is registered only after ack, which is what the client's probe-before-flush wants.

## 1.3 Client consumer

- `client/src/lib/ndjson.ts` (new, pure) — `readNdjsonLines(body: ReadableStream<Uint8Array>)`: `getReader()` + `TextDecoder.decode(chunk, {stream:true})` + carry-over split on `\n`; throw `NdjsonTrailingDataError` on a non-empty tail. **Not** `pipeThrough(TextDecoderStream)` nor `for await` over the body: Safari lacks async iteration on `ReadableStream`; `getReader()` + `TextDecoder` are well inside Safari 16. Browser un-gzips transparently.
- `api/syncClient.ts` — `openBootstrapStream(deviceId)` (`fetch` with `credentials: 'include'`, `X-Device-Id`; `throwForStatus`; returns `readNdjsonLines(res.body)` through a hand-written `parseBootstrapLine(unknown)` narrowing on `t`, zod is not a client dep). Resolves when **headers** arrive, i.e. once the server has bound the session — that is what the gate must bracket. `ackBootstrap(ack)` POSTs JSON with `X-Device-Id`. `timezoneReportParam` + `describeDevice` move to the ack call site. `fetchBootstrap`/`BootstrapPayload` deleted at step 7. Mock: `openBootstrapStream: vi.fn()`, `ackBootstrap: vi.fn().mockResolvedValue(undefined)`.
- `db/bulkPut.ts` (new) — `putEntityChunk(db, storeName, rows, ownerUserId)`: one readwrite tx per chunk; per row `get` then write only when `!existing || incomingWinsLww(...) || isPoisonedWatermark(...)` (move those two from syncHelpers 571–579 to `lib/lww.ts`). Rationale: today's unconditional `put` was tolerable for a seconds-long window; a minutes-long stream makes "user captured an item mid-bootstrap, snapshot overwrote it" realistic. Replaces the four copy-pasted transactions at 348–358 and the bootstrap use of `bulkPutItems`.
- `contexts/bootstrapProgressStore.ts` (new; shape of `syncRecoveryStore`) — `{phase:'idle'} | {phase:'bootstrapping', userId, received, expected?} | {phase:'error', userId, message}`; `useBootstrapProgress()` via `useSyncExternalStore`.
- `db/syncHelpers.ts` —
  - `openBootstrapForUser(db, userId): Promise<PendingBootstrap>` (assert active session + `getOrCreateDeviceId` + `openBootstrapStream`). **Caller holds the session gate.**
  - `completeBootstrap(db, pending)` — **outside any gate**: progress → bootstrapping; consume lines, buffering per store and flushing at `BOOTSTRAP_CHUNK_ROWS = 1000` **or on entity-type change** under `withCrossContextLock(SYNC_APPLY_LOCK, () => putEntityChunk(...))` (lock per chunk, released between chunks so SW/other-tab pulls interleave); `keepalive`/unknown `t` ignored; `end` → flush + cursor; exhausted without `end` → `BootstrapIncompleteError` (new, exported through the mock companion like `SyncAuthError`). Then `withAccountSession(db, userId, () => ackBootstrap(...))`, **then** `setSyncCursor` under the apply lock. Ack-then-cursor: a tab dying in between leaves no cursor → re-bootstrap (no rewind, cheap); the reverse leaves a cursor with no server row → 409 → recovery dialog. Progress → idle, or → error + rethrow.
  - `bootstrapFromServer(db, userId)` = `withSessionGate(openBootstrapForUser)` then `completeBootstrap`; the gate now brackets only the headers round-trip, so the 10 s self-release stops firing for bootstraps. `bootstrapInFlight` map dedups same-tab double triggers (mirror `pullInFlight` 441–447). Delete `bootstrapFromServerUnguarded` after callers migrate.
  - Retry/resume: **restart from scratch** on any failure (no cursor, no ack, lease expires, already-put chunks are an LWW-safe subset). Existing triggers (mount, `online`, SSE, `runCatchUpPull`) re-enter `pullOrBootstrap`.
- `db/multiUserSync.ts` — the gated block (43–61) collects `PendingBootstrap[]`; after the gate releases, `completeBootstrap` each, then `withAccountSession(...onUserSynced)` so calendar sync runs after the data exists. `pullOrBootstrap` returns `openBootstrapForUser` when no cursor; the `BootstrapRequiredError` catch (277–281) uses a new `syncRecovery.openBootstrapRequiredRecovery` that returns a pending for Case 1. `syncSingleUser` (74) gets the same split.
- `db/syncRecovery.ts` / `syncRecoveryActions.ts` — Case-1 clears `case1Syncing` only after `completeBootstrap`; `pushQueuedChangesAndBootstrap` (32–43), `discardQueuedChangesAndBootstrap` (55), `retryBootstrap` (63): `withAccountSession(flush + open)` returns the pending, `completeBootstrap` outside, then idle + refresh.
- `serviceWorker.ts` — no change (SW defers `BootstrapRequiredError` to the foreground, 137–142); verify no import of the unguarded function.
- `db/devTools.ts` — `__gtd.bootstrapProgress()` for e2e.

## 1.4 IDB schema v9

- `db/indexedDB.ts` — `openDB('gtd-app', 9)`; `if (oldVersion < 9) await resetItemsForStreamedBootstrap(tx)`: `items.clear()` **first**, then `createIndex('userId_status', ['userId','status'])` and `createIndex('userId_updatedTs', ['userId','updatedTs'])` (index on an emptied store is instant; on 20k rows the versionchange tx would stall the `blocked` window), then `syncCursors.clear()` (otherwise `pullOrBootstrap` pulls incrementally and never refills items). Keep `syncOperations` (queued creates carry their own snapshot), `routines/people/workContexts/reviewInboxes`, `deviceMeta`. Comment the why.
- `types/MyDB.ts` 366–370 — `items.indexes: {userId; userId_status: [string, StoredItem['status']]; userId_updatedTs: [string, string]}`.
- Consumers of `getAllFromIndex('items','userId')` untouched in Phase 1; Phase 2 candidates: `itemHelpers.ts` 7/17/37/53/69/75 (`getItemsByStatus`, `getUpcomingCalendarItems`, `getOverdueItems`, `getItemsAcrossUsers`); `routineItemHelpers.ts` (12 sites, all filter by `routineId` → would want `[userId, routineId]`, out of scope); `routineSplitUtils.ts` 46, `RoutineEditorBody.tsx` 409, `routineClarifyMutations.ts` 52; `exportRecoveryData.ts` 53 and `accountHelpers.ts` 141 stay on `userId`.

## 1.5 Progress UI

- `components/SyncingChip.tsx` — optional `progress?: number` → `CircularProgress variant="determinate"`; indeterminate when absent; `tone?: 'neutral' | 'warning'`.
- `components/AccountSyncChip.tsx` — reads `useBootstrapProgress()` **and** `isInitialSyncing`; label `Syncing account… 42%` when `expected` known, `Syncing account… 12,340` otherwise; error phase → warning chip `Sync failed — retrying on next sync` (`data-testid="syncErrorChip"`; keep `syncingChip` for bootstrapping). The 12 `isInitialSyncing` consumers and `AppDataProvider` stay unchanged.
- Progressive list fill (refresh app resource every N chunks) deferred to Phase 2 (changes skeleton semantics).

## 1.6 Cloud Run / proxy

- `.github/workflows/deploy-api.yml` — add `--timeout=600` to `gcloud run deploy`. Streaming fixes TTFB; the 300 s default still caps total duration and a cut stream restarts from scratch. Chunked HTTP/1.1 streams by default; no `--use-http2`.
- `workers/api-proxy/src/index.ts` — **no change**; `fetch(proxied)` passes the body through un-buffered. Cloudflare may transcode gzip→brotli, transparent to the browser. Staging check: `curl -N --compressed -H "Cookie: …" -w '%{time_starttransfer}\n' https://api-staging…/sync/bootstrap/stream` → sub-second TTFB, progressive output.

## 1.7 Tests

**api-server** (Docker Mongo `slc-database-1`)
- `tests/helpers.ts` — `readGzipNdjson(res)` (`gunzipSync` + split + parse; `app.fetch` bypasses HTTP so nothing auto-decodes) and `readNdjsonPrefix(res, n)` (reader + cancel, for abandon tests).
- `tests/bootstrapStream.test.ts` (new; lifecycle from `sync.test.ts` 15–44 + `bootstrapLeases` wipe): line order; `meta.expected` = `end.counts` = seeded counts; user isolation; 401; headers; `end.cursor` = held-back boundary (holdback `'0'` env) and = existing row's cursor when ahead (port of `sync.test.ts:1582`); stream creates **no** device row but **does** create a lease; abandoned stream (read 2 lines, cancel) → no row, lease present, sibling pull's purge keeps ops above the lease, expired lease ignored; `chunkForFlush` fake-timer tests (maxRows, maxMs, keepalive, `return()` forwarding).
- `tests/bootstrapAck.test.ts` (new): creates row with cursor/label/timezone/fresh `lastSeenTs` (port of `sync.test.ts` 700–745, 1330, 1711); forward-only (`recorded:false`, `lastSeenTs`/label refreshed); releases lease; 400 on zod / user mismatch / holdback; after ack `/device-status` registered and `/sync/pull` no longer 409s (port of 1306).
- `sync.test.ts` — at step 10 port the remaining JSON-bootstrap assertions (626–810) to stream+ack. `maintenance.test.ts` — purge respects an active lease.

**client** (node env)
- `tests/ndjson.test.ts` (new): split across chunk boundaries, multi-byte UTF-8 split mid-character, CRLF, blank lines, trailing partial line throws.
- `tests/syncClient.test.ts`: `openBootstrapStream` 401 → `SyncAuthError`, missing body throws, yields parsed lines from a `ReadableStream` fixture; `ackBootstrap` body/headers + non-ok throws; move the two `deviceLabel` tests (37–55) to the ack.
- `tests/helpers/bootstrapStream.ts` (new): `bootstrapStreamOf({items, routines, people, workContexts, reviewInboxes, cursor, withEnd})`, `EMPTY_BOOTSTRAP_STREAM`.
- `tests/syncHelpers.test.ts` `bootstrapFromServer` describe (973–1023) rewritten: all types + cursor; `user → userId` remap; 2,500 items → 3 chunks, lock acquired once per chunk (share `fakeLockManager` from `crossContextLock.test.ts` 10–27); ack after last chunk and before `setSyncCursor` (call order); no `end` → `BootstrapIncompleteError`, no ack, no cursor, partial rows present; ack rejection → no cursor; LWW keeps a newer local row; progress transitions; gate held only around the open (a queued gate task runs mid-consumption); `bootstrapInFlight` dedup. Update the lock-wiring test at 634.
- `tests/multiUserSync.test.ts` (151, 387–395): new mocks; bootstrap completes after gate release; two-account device acks user C after pivot and restores the prior session; `onUserSynced` fires after `completeBootstrap`.
- `tests/syncRecovery.test.ts` (77–196) + `syncRecoveryActions.test.ts`: stream fixture; Case-1/2 clear `case1Syncing`/`bootstrapping` only after completion.
- `tests/indexedDBMigration.test.ts`: `v8 → v9` describe — items + syncCursors empty, both indexes exist, other stores preserved, v2→9 chain healthy (89–112). `tests/bootstrapProgressStore.test.ts` (mirror `syncRecoveryStore.test.ts`).

**e2e**
- `devLogin.ts` `POST /dev/seed-items {email, count, status?}` (insertMany in 1,000-row batches; no ops needed). Wrapper `seedServerItems` in `e2e/helpers/context.ts`.
- `e2e/bootstrap-stream.spec.ts` (new): (1) fresh device streams — `waitForResponse('/sync/bootstrap/stream')` is `application/x-ndjson`, seeded item renders, non-epoch cursor, `/device-status` registered; (2) 20k seeded — `syncingChip` shows `/\d+%/`, `expect.poll` reaches 20k within 60 s, registered; (3) abandoned — close the context mid-stream, `device-status` → `registered:false`, reopen with the same cookie → completes → `registered:true`.
- Re-check (no edits expected): `initial-sync-skeleton.spec.ts:37`, `multi-device-sync.spec.ts` 117–160, `device-management.spec.ts:109`, `login.ts waitForSyncSettled` 70–94.
- `e2e/helpers/gtd.ts:266 fetchBootstrap` (~25 specs): before step 10, re-implement in-browser over the stream returning the same `{items, routines, people, workContexts}` shape so those specs stay untouched.

**Docs**: CLAUDE.md Sync Architecture (bootstrap + purge rule includes leases), `client/CLAUDE.md` bootstrap section + IDB table, `docs/DATA_MODEL.md` (`bootstrapLeases`).

## Phase 1 implementation order

1. Server refactor, no behaviour change — `lib/bootstrapCursor.ts`, `loadPurgeFloor` replacing the two floor bodies.
2. Leases — DAO, entity type, loader wiring, `/dev/reset` wipe, floor folds in active leases; tests in `maintenance.test.ts` + `sync.test.ts`.
3. Stream route — `lib/bootstrapStream.ts` (+ `chunkForFlush` tests), `GET /sync/bootstrap/stream` writing a lease; `bootstrapStream.test.ts`. JSON route untouched.
4. Ack route — schema, `lib/bootstrapAck.ts`, `POST /sync/bootstrap/ack`; `bootstrapAck.test.ts`; `--timeout=600` in `deploy-api.yml`.
5. Client wire layer — `lib/ndjson.ts`, `openBootstrapStream`/`ackBootstrap` + mock + `BootstrapIncompleteError`; tests. Nothing calls them yet.
6. Client consume path — `db/bulkPut.ts` + `lib/lww.ts`, `bootstrapProgressStore`, `openBootstrapForUser`/`completeBootstrap`; unit tests.
7. Switch callers — `bootstrapFromServer`, `multiUserSync` pending handoff, `syncRecovery*`; delete `bootstrapFromServerUnguarded`, `fetchBootstrap`, `BootstrapPayload`; e2e `fetchBootstrap` helper over the stream; `/dev/seed-items` + `bootstrap-stream.spec.ts` cases 1 and 3; run touched specs + `initial-sync-skeleton`, `multi-device-sync`, `device-management`.
8. Progress UI — `SyncingChip` determinate, `AccountSyncChip` tri-state, `__gtd.bootstrapProgress`; e2e case 2.
9. IDB v9 — after step 7 so upgrading devices refill via the stream.
10. Delete `GET /sync/bootstrap` (JSON) + port remaining `sync.test.ts` bootstrap tests + docs. **Must trail the client rollout**: old bundles call the JSON route until they reload. With "ship 0+1 together", this is a follow-up commit after the staging client is live, not part of the initial merge.

## Phase 1 risks

- **Purge-floor gap during the stream** — closed by the lease (1.2). Without it a multi-device user can silently lose an op.
- **Session pivot race no longer masked by the gate** — the ack is a second request under whatever cookie is active; mitigated by gate-around-open, `withAccountSession` around the ack, and the server's `user_mismatch` rejection.
- **gzip flush overhead** — per-chunk `Z_SYNC_FLUSH` only; never per row.
- **Server memory** — generator + `batchSize: 200` + `.pipe` backpressure keep memory O(chunk); only the five counts are O(n) and index-only.
- **Cloud Run cap** — `--timeout=600` still finite; Phase 2's hot-set filter is the real fix for huge accounts. Watch logs for restart loops (`client disconnected` vs acks).
- **IDB v9 clears items + cursors on every device at once** — thundering re-bootstrap on deploy day; staging first, production off-peak. `createIndex` after `clear()` keeps the versionchange tx instant.
- **Two tabs bootstrapping the same user** — both stream and both ack (forward-only makes it idempotent); cross-tab dedup is a Phase 2 nicety.
- **LWW per row** slows chunk writes slightly (one `get` per row in-tx) but removes the mid-bootstrap overwrite bug.

---

# Open points for approval

1. **`bootstrapLeases` collection** (1.2) is a design addition beyond the GTD item: it is what keeps the purge floor safe while the row write moves to the ack. Alternative is to accept the gap; not recommended.
2. **Cloud Run `--timeout=600`** for the whole service (Cloud Run has no per-route timeout).
3. **Client LWW on bootstrap writes** (1.3 `putEntityChunk`) instead of unconditional `put`.
4. **Deleting the JSON bootstrap route** is a follow-up commit after the client is live on staging, not part of the initial merge.
5. **Phase 0 cron purge** is hygiene, not the storm fix (per-user reaping already runs on every pull); keep it in scope, or drop it to shorten Phase 0.
