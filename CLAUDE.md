# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack offline-first GTD (Getting Things Done) productivity app — monorepo with:
- `api-server/` — Node.js/Hono/TypeScript backend on port 4000
- `client/` — React 19/TypeScript/Vite PWA frontend on port 4173
- `e2e/` — Playwright end-to-end suite (drives the real client + API)
- `mcp-server/` — local MCP server exposing GTD tools over the public `/v1` API
- `workers/api-proxy/` — Cloudflare Worker fronting the API domains

Full data model, item statuses, tickler rules, sync and calendar reference: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).
Public API reference: [`docs/PUBLIC_API.md`](docs/PUBLIC_API.md). Deploy/infra runbook: [`docs/gcp-deploy-plan.md`](docs/gcp-deploy-plan.md).

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
npm start            # Run compiled server
npm run test         # Run Vitest tests
npm run lint         # Biome lint check
npm run lint:fix     # Auto-fix lint + format (Biome)
npm run typecheck    # tsc --noEmit
```

API tests need a local Mongo. Use a throwaway container: `docker run -d --rm --name gtd-test-mongo -p 27017:27017 mongo:8.0`.

### Client (`cd client`)
```bash
npm run dev                          # Watch build + preview server (port 4173)
npm run build                        # generate-typed-css-modules + vite build + tsc -b
npm run generate-typed-css-modules   # Regenerate .css.d.ts for CSS Modules
npm run test                         # Run Vitest tests
npm run lint                         # Biome lint check
npm run lint:fix                     # Auto-fix lint + format (Biome)
npm run typecheck                    # tsc -b --noEmit
npm run preview                      # Preview production build
npm run storybook                    # Storybook on port 6006
```

### E2E (`cd e2e`)
```bash
npm run test                    # Full Playwright suite (slow)
npx playwright test <spec>      # Single spec — the inner loop
npm run lint:fix                # Biome format + lint
```

Playwright's `webServer` starts the API with `TZ=UTC BRIEF_FAKE_MODEL=1` and the client via `npm run dev`.

**Always `await gtd.flush()` before `page.goto()`** after a `gtd.*` mutation — navigating mid-flush wedges the IndexedDB flush lock for 30s.

If e2e fails although the change is present in the built bundle, port 4173 is being served by a stale `vite preview` (it caches the startup `index.html`) or by another worktree's dev server. Restart the preview and verify the served bundle hash.

## Architecture

### Auth Flow
Better Auth — Google and GitHub OAuth. Accounts with matching emails are linked to one user. Session stored in MongoDB; HTTP-only cookie `better-auth.session_token`. Client tracks login state in IndexedDB (`accounts` / `activeAccount` stores) rather than React state.

A second, parallel auth path — bearer tokens (`gtd_<random>`) — serves the public `/v1/*` API, the MCP server and external integrations. Both paths resolve to the same Better Auth user id. See `api-server/CLAUDE.md`.

### Offline-First Design
The client is a PWA with a Service Worker. All entities are stored in **IndexedDB** (via `idb`) with a `syncOperations` store for queueing changes when offline. The router context passes `db` to all routes.

### Routing
Uses `@tanstack/react-router` with file-based routing under `client/src/routes/`. Routes under `_authenticated/` are protected. Root layout is in `__root.tsx`.

### Data Access (API)
`abstractDAO.ts` wraps MongoDB — one DAO per collection under `api-server/src/dataAccess/`, each initialized as a singleton in `loaders/mainLoader.ts`. Better Auth owns the `user` collection; `UsersDAO` no longer exists.

### Key Types

All server-side interfaces live in `api-server/src/types/entities.ts`. Client-side mirrors (prefixed `Stored*`) live in `client/src/types/MyDB.ts`. Field-level reference lives in [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) § Schema Reference — read it rather than re-deriving field lists.

**Synced entities** (`EntityType`, replicated to devices through the operations log):

| Entity | Collection | Purpose |
|---|---|---|
| `ItemInterface` | `items` | Core GTD task. Status drives which optional fields apply. |
| `RoutineInterface` | `routines` | Recurring task template. Generates `nextAction` / `calendar` items on a schedule. |
| `PersonInterface` | `people` | Named contact. Referenced by `peopleIds` and `waitingForPersonId` on items. |
| `WorkContextInterface` | `workContexts` | Condition tag (e.g. "near a phone"). Referenced by `workContextIds` on items. |
| `ReviewInboxInterface` | `reviewInboxes` | Weekly Review session state (staged batches, progress). |
| `ItemBriefInterface` | `itemBriefs` | One-to-one AI/user brief sidecar for an item (`_id === item._id`). |

Everything else (`operations`, `deviceSyncState`, `calendarIntegrations`, `apiTokens`, `briefBatches`, …) is **server-only** and never reaches a client; one DAO per collection under `api-server/src/dataAccess/` is the inventory.

Adding a synced entity is a **client change too**: `client/src/db/syncHelpers.ts` needs the new `case` arm and the IDB store, or pre-upgrade tabs silently skip the ops.

### Sync Architecture

All mutations are recorded as `OperationInterface` documents on the server. Each operation stores the **full entity snapshot** at the time of the change (not a diff), making last-write-wins conflict resolution trivial: the operation with the latest `ts` wins.

Client-side flow:
1. Change written to IndexedDB → `SyncOperation` queued with `userId`, `entityType`, `entityId`, `opType`, and snapshot
2. On reconnect → `flushSyncQueue()` replays ops to the server in `queuedAt` order
3. Device pulls new ops from server since its sync cursor and applies them locally

**Purge rule:** operations older than the purge floor (`min` cursor across all of a user's devices) are safe to delete.

All entities carry `updatedTs` (ISO datetime) as the conflict-resolution anchor. Client IDs are stable UUIDs generated on first launch (`deviceId` in `DeviceSyncStateInterface`).

**Op snapshot schemas (`api-server/src/schemas/operations/`) must stay a strict superset of the entity interface.** A schema narrower than the interface 400s the whole `/sync/push` batch and permanently jams the client's push queue.

### Calendar Integration

`CalendarIntegrationInterface` holds OAuth credentials (encrypted at rest); `CalendarSyncConfigInterface` holds per-calendar sync state within an integration.

- **Items:** a `calendar` item linked to Google Calendar carries `calendarEventId` + `calendarIntegrationId`. Changes sync bidirectionally.
- **Routines:** a `calendar` routine can own or attach to a Google Calendar recurring event series via `calendarEventId`. The app can either create a new series or import an existing one.

The unique index on `calendarEventId` is scoped to `status: 'calendar'` — `trash` rows keep their `calendarEventId` so a revive can relink. The `(user, calendarInstanceEventId)` unique index is **not** status-scoped (presence-partial only): a done routine occurrence, or one the user trashed (in-app, or via `POST /v1/items/:id/trash` / MCP `gtd_trash_item`), keeps owning its instance id — only sync-engine trash paths (routine delete, regeneration, inbound cancellation, dead-twin demotion) `$unset` it — so an orphan insert for that instance raises E11000.

- **Done/trash markers:** completing a linked item keeps the Google event and marks it (`✓ ` title prefix + sage `colorId`); trashing deletes a standalone event or cancels the single routine occurrence. A routine's series master is never patched or deleted from an item push.
- **Pushback failures** are recorded on the op (`syncFailed`, `failureReason`) and surfaced in the SyncIssuesPanel with Retry (retryable reasons) or Dismiss only. Pushes against a `suspended`/`revoked` integration are dropped without any marker; the only repair is `POST /calendar/integrations/:id/sync` (run by the client on every sync cycle, and by "Sync now"): its outbound backfill creates Google events for entities that never got a link, and its missed-push sweep re-pushes standalone `calendar`/`done` items and routine occurrences that carry a client-written `modified` exception — not trash rows.
- Pushback internals: `api-server/README.md` § Calendar Pushback; rules for changing it: `api-server/CLAUDE.md` § Calendar pushback.

### Item Briefs (AI)

A **brief** is a one-line, review-oriented condensation of an item's title + notes, shown in place of the notes preview during the Weekly Review. It is a **sidecar synced entity** (`itemBrief`, `_id === item._id`), never a field on `items` — a server-written brief on the item itself would beat an unpushed offline edit under LWW.

- `sourceHash` (`briefSourceHash`, mirrored in `api-server/src/lib/briefSource.ts` ↔ `client/src/lib/briefSource.ts` with a parity test) gates display: a `model` brief is shown only while it matches the item's current title+notes hash, otherwise it degrades to the notes preview.
- `origin`: `model` / `skipped` are server-written only; `user` / `agent` are **pinned** and the sweeper never overwrites them.
- Generation paths: the Message Batches sweep (`lib/brief/briefBatch.ts`, `POST /maintenance/briefs/sweep`, driven by a Cloud Scheduler job), on-demand `POST /v1/items/:id/brief/generate`, and authored writes via `PUT /v1/items/:id/brief` / MCP.
- Model is `BRIEF_MODEL` in `lib/brief/briefPrompt.ts`. `BRIEF_FAKE_MODEL=1` returns a deterministic stand-in for e2e (production refuses to boot with it set); `BRIEF_INLINE_ON_WRITE=1` is an off-by-default operator escape hatch that regenerates after each item write.

Design detail: [`docs/plans/item-brief.md`](docs/plans/item-brief.md); schema: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) § Item briefs.

### Entry Points
- `api-server/src/index.ts` — builds the Hono app, starts the server, loads DB and auth
- `client/src/main.tsx` — initializes IndexedDB, renders app
- `client/src/App.tsx` — sets up router context
- `client/src/serviceWorker.ts` — custom Workbox Service Worker (background sync + push)

## Code Style
- Biome: 160-char line width, 4-space indent, single quotes
- TypeScript strict mode enabled
- Biome handles all formatting and linting automatically (`npm run lint:fix`). Do not manually fix formatting, import order, or other issues that Biome enforces — just run `lint:fix`.

## Coding Standards

These apply repo-wide. `client/CLAUDE.md` and `api-server/CLAUDE.md` add only project-specific rules on top.

### Comments

Whenever making a code change that is not immediately obvious — e.g. a workaround, a non-obvious prop or flag, a subtle timing dependency, or a browser-specific fix — add a concise inline comment explaining why it is needed. One to three lines is usually enough. Skip comments where the code is self-evident.

### File Naming

- Non-component files (hooks, utilities, scripts, etc.): **camelCase** (e.g., `useSomething.tsx`, `myUtil.ts`)
- Component files: **PascalCase** matching the component name (e.g., `MyComponent.tsx`)

### TypeScript
- No `any`. Use `unknown` when the type is genuinely unknown.
- Prefer inferred types over explicit annotations — including function return types. Only annotate when inference would produce `any` or an unacceptably wide type.
- Prefer generics (`<T>`) and mapped/conditional/template literal types over `as` casts. Type assertions must be rare and justified.
- Use `hasAtLeastOne(arr)` from `lib/typeUtils.ts` instead of `arr.length > 0` — it narrows `T[]` to `NonEmptyArray<T>`, eliminating `arr[0]!` assertions. Use `NonEmptyString` (same file) for strings known to be non-empty.

### Functions
- ≤ 5 meaningful actions per function, typically ~5 lines.
- Single level of abstraction per function — if a function orchestrates, it calls named helpers; it does not contain inline implementation details.
- In any code block longer than 4 lines, always wrap `return`, `throw`, or `continue` after a condition in curly braces for scannability. In code blocks of 4 lines or fewer, the braceless single-line form is acceptable:
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

### Tests
Every implementation step adds unit **and** Playwright e2e coverage. Lint/typecheck/existing tests passing is not enough.

## Post-Change Checklist

After any code change — bug fix, feature, or refactor — run the following cycle for each affected project. **Repeat from step 1 until every step passes.**

**Client changes:**
1. `cd client && npm run generate-typed-css-modules` — regenerates `.d.ts` files for CSS Modules
2. `npm run lint:fix` — Biome format + lint (may auto-correct files; subsequent steps run on the corrected state)
3. `npm run typecheck`
4. `npm run test`
5. Invoke the `client-code-reviewer` subagent (canonical source: `client/.claude/agents/code-reviewer.md`)

**API server changes:**
1. `cd api-server && npm run lint:fix` — Biome format + lint
2. `npm run typecheck`
3. `npm run test`
4. Invoke the `api-code-reviewer` subagent (canonical source: `api-server/.claude/agents/code-reviewer.md`)

**E2E changes (any file under `e2e/`):**
1. `cd e2e && npm run lint:fix`
2. `npx playwright test <changed specs>` — only specs that actually changed; full suite is too slow for the inner loop

A stop hook (`scripts/post-change-checks.sh`) runs the client / api-server / e2e blocks **in parallel** after each Claude response. It exits 2 (blocking) on any failure so Claude is automatically re-invoked until everything is green. It skips entirely unless a PostToolUse hook touched the `.claude/.edited-this-turn` sentinel — a manual rerun after the sentinel is consumed is a silent no-op.

**Lint warnings count as failures.** Biome warnings printed by `lint:fix` (typically `noNonNullAssertion` and other "unsafe fix" categories) must be cleaned up in the same turn that surfaces them. Do not finish a turn while warnings remain, even if the script exits 0. The preferred fix for `arr[0]!` in tests is destructure-then-narrow:
```ts
expect(arr).toHaveLength(1);
const [call] = arr;
if (!call) throw new Error('expected one X');
// use `call` directly — no `?.` chain, no `!`
```
`?.` masks "array unexpectedly empty" bugs in tests; the throw makes the failure mode explicit.

**The code-reviewer subagents are mandatory and non-negotiable.** Never consider a task complete until the relevant reviewer has been invoked and returned "Approved". If it returns "Changes requested", fix all issues and repeat the full cycle from step 1.

**Never commit or push without explicit per-change approval.** Auto mode authorizes work, not shipping.

### Why two agents (and where they live)

The two reviewers are kept separate because they encode different stack-specific knowledge (React 19/MUI/IDB vs. Hono/MongoDB/Better Auth). Each canonical definition lives next to the code it reviews (`client/.claude/agents/code-reviewer.md`, `api-server/.claude/agents/code-reviewer.md`).

For sessions started at the monorepo root, both are exposed via symlinks at `.claude/agents/` (`client-code-reviewer.md` → client, `api-code-reviewer.md` → api-server). Edit the canonical files in the subdirectories — the symlinks track them automatically. The frontmatter `name:` fields (`client-code-reviewer`, `api-code-reviewer`) match the symlink filenames, so each resolves to one and only one agent regardless of which directory the session was started from.

Commit additions under `api-server/.claude/agent-memory/` — do not gitignore them.

## Running Locally

```bash
# Terminal 1 — API server (port 4000)
cd api-server && npm run dev

# Terminal 2 — Frontend (port 4173)
cd client && npm run dev
```

## Deployment

### Environments

| Environment | App URL | API URL | Cloud Run service |
|---|---|---|---|
| production | https://getting-things-done.app | https://api.getting-things-done.app | `gtd-api` |
| staging | https://staging.getting-things-done.app | https://api-staging.getting-things-done.app | `gtd-api-staging` |

### How to Deploy

- **Push-triggered**: push to the `staging` or `production` branch when `api-server/**` changes → auto-runs `.github/workflows/deploy-api.yml`
- **Manual**: `./scripts/deploy.sh api staging|production` — triggers the same workflow via `gh workflow run`
- Track progress: https://github.com/yuval-yssak/gtd-app/actions/workflows/deploy-api.yml

`gh` write operations on this repo need the active account `yuval-yssak` (not `yuval-winn-ai`). A working `git push` does not imply `gh` is on the right account.

### GitHub Environments

Configured at https://github.com/yuval-yssak/gtd-app/settings/environments — two environments (`production`, `staging`), each holding its own GCP secrets and vars. The workflow selects one by branch name (push) or `inputs.environment` (manual dispatch).

### Infrastructure

- **Backend**: Google Cloud Run, region `us-central1`, `--max-instances=1` and scales to zero — **no in-process timers**; anything periodic is a Cloud Scheduler job hitting an endpoint with the `x-cron-secret` header (value = `CRON_SECRET`).
- **API proxy**: Cloudflare Worker (`workers/api-proxy/`) routes both API domains to the respective Cloud Run service. The free tier's daily request limit can take staging offline; bypass via the raw Cloud Run URL + bearer token.
- **Docker images**: built from `api-server/Dockerfile` (build context is the repo root) and pushed to Google Artifact Registry.
- Full runbook, env-var inventory and Scheduler job setup: [`docs/gcp-deploy-plan.md`](docs/gcp-deploy-plan.md).

### Branch topology

`production` is an **unrelated history** that `main` supersedes (no merge-base). `staging` re-diverges from `main` because integration uses merge commits. `staging` and `production` carry classic branch protection with `allow_force_pushes: false` — the approved procedure is toggle it true, push with `--force-with-lease`, then restore false, sending the FULL config on the PUT.

### Service Worker (PWA)

The client is a PWA using `vite-plugin-pwa` with `strategies: 'injectManifest'` and a hand-written Service Worker at `client/src/serviceWorker.ts` (`client/vite.config.ts`). With `injectManifest`, **the `workbox:` option block is silently ignored** — precache globs must go under `injectManifest:`, or fonts fall out of the manifest and the offline shell cannot render.

`registerType: 'autoUpdate'` means the new SW activates immediately and takes over all open tabs, so **users need to reload once** to run the new JS/CSS. Known risk: a user offline at activation may have old JS lazy-load chunk URLs that are no longer precached, breaking the page until reload — inherent to `skipWaiting` in an offline-first app.

For development/debugging: DevTools → Application → Service Workers → "Update on reload".
