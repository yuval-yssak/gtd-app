# Plan — Playwright layer for browser-dependent sync scenarios

Status: **proposed, not started**. Written 2026-04-21 after the first audit run (see `FINDINGS-2026-04-21.md`) and the companion bug-fix commit landed real test count at 8/8.

## What this unblocks

Nine scenarios in `scenarios/A.app-originated.audit.ts` and `scenarios/B.gcal-originated.audit.ts` are declared `it.skip` because they require driving the React client (`client/`) rather than hitting the Hono API directly. The vitest harness can only exercise server-side code paths; the client layer — offline queue, horizon regeneration, routine-split UI, per-instance item mutations — never runs.

| ID | Scenario | Why it needs the browser |
|---|---|---|
| A2 | Modify a single instance in the app (time change) | The time-edit flow lives in `client/src/components/items/` and writes via IndexedDB → sync queue |
| A4 | Trash a single instance in the app | Same path — per-instance mutation on a routine-generated item |
| A6 | Change routine RRULE (this-and-following split) | Split UI in `client/src/components/routines/`; generates split op client-side |
| A7 | Delete routine in the app → GCal master is deleted | The `delete` opType pushback path runs client→server→gcal |
| A8 | Complete a single instance in the app | Item-complete flow mutates status in IndexedDB; pushback pushes to gcal |
| A9 | App-side change while offline, then reconnect | Requires toggling network, observing `syncOperations` store, reconnect flush |
| B5 | Change master RRULE in GCal → regenerates local items | Client regenerates items from new RRULE on sync pull |
| B6 | Change master time in GCal → shifts future items | Client-side horizon regen on routine update |
| B7 | Change master duration in GCal → updates timeEnd on future items | Same — client owns item materialization |

## Why not extend the vitest harness

The client's horizon materialization, offline queue, and item mutation flows all depend on IndexedDB, the service worker, and the React router context — none of which have a usable node-side shim. The current `test:sync-audit` harness runs the Hono app in-process; adding client-side paths would require duplicating ~3 layers of the client runtime. Running a real browser is cheaper.

## Proposed architecture

Reuse the existing `e2e/` Playwright setup (already in the monorepo — see `e2e/playwright.config.ts`). Add a new project inside that workspace:

```
e2e/
├── playwright.config.ts          # existing — add a 'sync-audit' project
└── sync-audit/                   # new
    ├── fixtures/
    │   ├── gcalClient.ts         # thin re-export of ../../api-server/src/tests-sync-audit/harness/gcal.ts
    │   ├── seedAccount.ts        # re-exports seed helpers; resolves the secrets path
    │   └── auth.ts               # navigates through better-auth login OR injects a session cookie via the playwright API
    ├── specs/
    │   ├── A.app-originated.spec.ts    # A2, A4, A6, A7, A8, A9
    │   └── B.gcal-originated.spec.ts   # B5, B6, B7
    └── reporter.ts               # mirrors harness/reporter.ts: writes reports/playwright-sync-audit-<iso>.md
```

### Key reuses from the vitest harness

- **`harness/gcal.ts`** — the GCal wrapper already works from any Node context. Import directly. No changes needed.
- **`harness/seed.ts` + `harness/cleanup.ts`** — used verbatim in Playwright `beforeAll`/`afterAll`.
- **`harness/env.ts`** — same `.secrets/gcal-e2e.json`; same runId scheme.
- **Session cookie minter (`harness/sync.ts::mintSessionCookie`)** — inject directly via `page.context().addCookies()` to skip the OAuth dance.

### What's new per scenario

Each Playwright spec:

1. **Setup** (`beforeAll`): call `seedFreshAccount()`, mint a session cookie, `page.goto('/')` with the cookie pre-set.
2. **Act**: drive the UI (or mutate GCal directly for B-series) to trigger the scenario.
3. **Sync**: for A-series, trigger the offline→online toggle via `context.setOffline()`. For B-series, hit `POST /calendar/integrations/:id/sync` via `page.request.post()` (reusing the in-browser session).
4. **Assert**: read the final routine/item state via `page.evaluate(() => indexedDB...)` OR by calling `GET /routines` / `GET /items` through `page.request`.

## Scenario-specific notes

### A2, A4, A8 — per-instance mutations
The routine generates calendar items on a horizon. The UI needs to see those materialized items before the test can edit/trash/complete one. Add a helper `waitForHorizonRegen(page, routineId, expectedDate)` that polls `db.items.findArray({ routineId, timeStart: { ≈ expectedDate } })`.

### A6 — this-and-following split
Exercise the split UI at the dialog level. Needs a visible route (`/routines/:id` or similar — confirm at implementation time). Assert: a second routine was created with `splitFromRoutineId = parent._id` and parent's RRULE has `UNTIL=`.

### A7 — delete routine
Delete via UI → `syncOperations` enqueues a `delete` op for entityType `routine`. The server must pushback to GCal. The sync handler doesn't currently handle `delete` for routines (per FINDINGS); verify whether it's implemented before writing the test.

### A9 — offline then reconnect
`await context.setOffline(true)` → drive the change → `context.setOffline(false)` → `triggerSync()` → assert propagation. Catch for the flaky case where the service worker's precache stalls on first offline trip; use `page.waitForLoadState('networkidle')` pre-offline.

### B5, B6, B7 — GCal-side master changes
Mutate via `patchMasterEvent()` (reuse from vitest harness) → `triggerSync()` → assert client items via IndexedDB or the items API:
- B5: old items past the new RRULE's end are trashed; new items match new RRULE.
- B6: future items have updated `timeStart`.
- B7: future items have updated `timeEnd`.

## Reporter

Write a Playwright reporter that mirrors `harness/reporter.ts` — same scenario-id parsing, same markdown output format. Target path: `e2e/sync-audit/reports/playwright-sync-audit-<iso>.md`. Merge step (optional): a tiny node script that concatenates the two reports (vitest + playwright) into `reports/combined-<iso>.md` so stakeholders see one table.

## Estimated effort

| Task | Estimate |
|---|---|
| Wire up Playwright project + cookie injection + seed reuse | 0.5 day |
| Custom reporter + report format parity | 0.5 day |
| A2, A4, A8 (per-instance mutations) | 1 day |
| A6 (split) | 0.5 day |
| A7 (routine delete) — contingent on server-side `delete` op | 0.5 day + server work if missing |
| A9 (offline/reconnect) | 0.5 day |
| B5, B6, B7 (gcal-side master changes) | 1 day |
| Hardening + flake reduction (retries, network waits) | 0.5–1 day |

**Total: ~4–5 days** of focused work, assuming the client UI affordances for each scenario exist. If any scenario requires new client UI (e.g. an explicit "this and following" button, a "delete routine" menu), scope that separately before estimating.

## Prerequisites

1. **Confirm `A7` pushback** — check if `syncOperations` with `entityType: 'routine'`, `opType: 'delete'` is processed server-side. Grep `src/routes/sync.ts` and `src/lib/operationHelpers.ts`. If absent, that's a server change independent of Playwright work.
2. **Client dev server reliability** — `npm run dev` must produce a stable build under CI. Verify the current `preview` server works without manual intervention.
3. **Shared OAuth secret** — decide whether CI should own its own calendar or reuse the developer's `.secrets/gcal-e2e.json`. Latter is simpler; former avoids cross-tenant pollution.

## Open questions

- **Visual regression**: should specs capture screenshots at key points (dialog open, horizon rendered)? Probably not in v1 — keep scope to behavior assertions.
- **Parallelism**: the vitest harness uses `fileParallelism: false` because multiple suites would stomp on the shared seeded account. Playwright must follow suit (worker count = 1) unless we per-scenario isolate via `runId`-prefixed accounts.
- **Run cadence**: not in CI at first. Manual trigger, documented in README alongside `npm run test:sync-audit`. Promote to CI once flake rate is known.

## Success criteria

- All 9 skipped scenarios have real assertions and pass in isolation.
- Three consecutive runs produce identical pass/fail shape (no flakes).
- Report merges cleanly with the vitest audit report to give a single "17/17 scenarios covered" view.
