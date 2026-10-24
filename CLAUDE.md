# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack offline-first productivity app built around the GTD (Getting Things Done) method. The product is branded **"Done"** (`client/src/lib/appName.ts`; matches the Google OAuth consent screen) — "Getting Things Done"/"GTD" are David Allen Company marks and are only ever used to describe the method, never as the app's name. Monorepo with:
- `api-server/` — Node.js/Hono/TypeScript backend on port 4000
- `client/` — React 19/TypeScript/Vite PWA frontend on port 4173
- `e2e/` — Playwright end-to-end suite (drives the real client + API)
- `mcp-server/` — local stdio MCP server exposing GTD tools over the public `/v1` API (setup, multi-account and tool table: `mcp-server/README.md`). The **hosted** MCP endpoint (`/mcp`, OAuth sign-in, no token) is served by the API itself — `api-server/src/routes/mcp.ts` + `mcpOAuth.ts`, tools copied into `api-server/src/mcp/` — and is what new users connect to (Settings → Connect Claude).
- `tools/mcp-gtd/` — **superseded** four-tool MCP predecessor, untouched since May 2026. `e2e/mcp-server.spec.ts` still spawns its `dist/`, so it must stay buildable, but new MCP work goes in `mcp-server/`.
- `workers/api-proxy/` — Cloudflare Worker fronting the API domains (route map in `wrangler.toml`; no package.json)

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
npx vitest run src/tests/auth.test.ts   # single test file
```

API tests need a local Mongo. Use a throwaway container: `docker run -d --rm --name gtd-test-mongo -p 27017:27017 mongo:8.0`.

### Client (`cd client`)
```bash
npm run dev                          # Watch build + preview server (port 4173)
npm run build                        # generate-typed-css-modules + vite build + tsc -b
npm run generate-typed-css-modules   # Regenerate .css.d.ts for CSS Modules
npm run test                         # Run Vitest tests
npx vitest run src/tests/allDayDate.test.ts   # Single test file
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
npm run cleanup-e2e-seeds       # Drop calendar integrations leaked by /dev/calendar/seed-integration (mongosh, reads api-server/.env)
```

The e2e stack runs on **its own ports** — API `4100`, client `4273` (`e2e/helpers/env.ts`; override with `GTD_E2E_API_PORT` / `GTD_E2E_CLIENT_PORT` to run two worktrees side by side) — and Playwright always starts both itself (`reuseExistingServer: false`), so your dev servers on 4000/4173 are never touched or reused. The API runs with `TZ=UTC BRIEF_FAKE_MODEL=1`; the client is a `vite build` into `client/dist-e2e` against the e2e API, then `vite preview`. A port already taken fails the run loudly. Specs reach the stack through `API_URL` / `CLIENT_URL` from `helpers/env.ts` — never a hardcoded port; code inside `page.evaluate` runs in the browser and takes the URL as an argument. `global-setup.ts` builds `tools/mcp-gtd` and `mcp-server` once before workers spawn. `retries: 0` — a test that only passes on a retry is flaky and must be fixed. Prove a fix with `--repeat-each=N --workers=4`; test emails take `uniqueStamp()` (`helpers/uniqueStamp.ts`), because a bare `dayjs().valueOf()` collides when repeats start in the same millisecond and two runs then share one user's data.

Manual Google Calendar smoke-test plans (one Claude session per case, driven through Chrome) live under `e2e/gcal-sync-smoke/`; `CONTINUE_HERE.md` at the root is their index.

**Always `await gtd.flush()` before `page.goto()`** after a `gtd.*` mutation — navigating mid-flush wedges the IndexedDB flush lock for 30s.

If e2e cannot start because 4100 or 4273 is taken, an earlier run left a server behind (or another worktree's suite is running): stop it, or set the port variables above.

### MCP server (`cd mcp-server`)
```bash
npm run build        # tsc → dist/index.js (also runs on `npm install` via prepare)
npm run dev          # tsx watch; reads GTD_API_BASE / GTD_API_TOKEN from the shell
npm run test         # Vitest — fetch is mocked, no server needed
npm run typecheck && npm run lint:fix
```

An MCP client (Claude CLI / Desktop) holds the `dist/` process for its whole session — after editing source, rebuild **and** restart the client or it keeps running the old code.

### Verifying which build is running

Every build is stamped with the git short hash: `git rev-parse --short HEAD` locally, Settings → App → "Version" in the browser, `GET /version` → `{ commitHash }` on the API. Compare all three before debugging a "fix didn't land" report.

### Worktrees

`./scripts/setup-worktree.sh` (run from the source checkout) copies the gitignored files a worktree needs — `api-server/.env`, `client/.env`, `.vscode/*`, per-package `.claude/settings.local.json`, the sync-audit secrets — into a chosen worktree and runs `npm i` in `api-server/` and `client/`. Without it a fresh worktree boots with no OAuth config.

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

### User data scope: deletion + export (GDPR)

Account deletion (`DELETE /auth/me`, the admin CLI `api-server/src/scripts/deleteUser.ts`) and the data export (`GET /export`, Settings → "Download my data") are both driven from **one list**: `api-server/src/lib/userDataInventory.ts`. Each entry names the collection, its owner filter (owner fields differ: `items.user`, `deviceUsers.userId`, `entityMoves.fromUserId|toUserId`, Better Auth rows by `userId` as string **or** ObjectId) and an export policy — `full`, `redacted` (with the exact fields stripped) or `omitted` (with the reason the user sees).

**Rule for every future change that touches user data:**

- A **new collection** holding anything of the user's — content they wrote, metadata about them, state derived from their data — goes into `USER_DATA_COLLECTIONS` (deletion + export) or, only if it truly holds no per-user rows, into `NOT_USER_SCOPED_COLLECTIONS` with a reason. `api-server/src/tests/userDataInventory.test.ts` enumerates every DAO and the Better Auth collections and fails until the decision is made; `tests/userDataFixtures.ts` needs a matching fixture row.
- **User-authored content is exported in full** (items, routines, people, work contexts, review inboxes, …). **Generated or derived content** (item briefs, device sync cursors) is still in the **deletion** scope — it must vanish with the account — and is exported when it is useful to the user; a transient replication log like `operations` may be `omitted`, never silently left out.
- A **new field** on an existing collection that holds a credential, token, hash, push key or webhook secret must be added to that collection's `redacted` list, or the export leaks it. A new field holding the user's content needs nothing — `full` exports whole rows.
- The **client mirror**: a new IndexedDB store holding user rows must be added to `wipeUserData` in `client/src/db/accountHelpers.ts` (sign-out **and** account evaporation) and to the local snapshot in `client/src/db/exportRecoveryData.ts`.

The tombstone (`deletedUsers`) carries only the user id and the deletion time — never the email — because the privacy policy promises that only the fact of the deletion is kept. Details: `api-server/README.md` § Account deletion & data export.

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
- **Server-owned link fields survive client edits.** The Google link is stamped server-side after the create and reaches devices through its own op; a snapshot pushed before that pull lacks the link, so the apply pipeline carries `calendarEventId` & co. forward from the stored row (`api-server/src/lib/calendarLinkCarryForward.ts`) and the client merges them into a newer local row (`client/src/db/calendarLinkMerge.ts`). Detach statuses are the exception — there the client strips the link on purpose.
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
- Biome: 160-char line width, 4-space indent, single quotes. One config for the whole repo (`biome.jsonc` at the root); each package runs its own `biome check`, so lint from inside the package you changed.
- TypeScript strict mode enabled
- Biome handles all formatting and linting automatically (`npm run lint:fix`). Do not manually fix formatting, import order, or other issues that Biome enforces — just run `lint:fix`.

## Coding Standards

These apply repo-wide. `client/CLAUDE.md` and `api-server/CLAUDE.md` add only project-specific rules on top.

### Scripts are code

The standards apply to **every** JS/TS file, not only the request-serving server and the app: the operator CLIs under `api-server/src/scripts/`, `e2e/scripts/`, Storybook config and one-off migration runners included. Keep a script's decisions — what to patch, which rows qualify, what the counts mean — in pure, exported functions with a test beside the other tests (`backfillItemRanks.test.ts`, `deleteUserCli.test.ts` are the pattern); the database side stays thin. Two script-specific facts: the CLIs print to a terminal and are therefore exempt from the log-redaction scan (§ Logging), so request-serving code must never import from `scripts/`; and a one-off mongosh runner is plain JavaScript (mongosh runs no TypeScript), so the TypeScript section is the only one that does not apply to it.

### Comments

Whenever making a code change that is not immediately obvious — e.g. a workaround, a non-obvious prop or flag, a subtle timing dependency, or a browser-specific fix — add a concise inline comment explaining why it is needed. One to three lines is usually enough. Skip comments where the code is self-evident.

Do not write comments that paraphrase the code, restate the function name, or narrate the current task ("added for the brief flow", "used by X"). Those rot and add noise. Write the comment only when removing it would leave a future reader puzzled.

### File Naming

- Non-component files (hooks, utilities, scripts, etc.): **camelCase** (e.g., `useSomething.tsx`, `myUtil.ts`)
- Component files: **PascalCase** matching the component name (e.g., `MyComponent.tsx`)

### TypeScript
- No `any`. Use `unknown` when the type is genuinely unknown.
- Prefer inferred types over explicit annotations — including function return types. Only annotate when inference would produce `any` or an unacceptably wide type.
- Prefer generics (`<T>`) and mapped/conditional/template literal types over `as` casts. Type assertions must be rare and justified.
- Use `hasAtLeastOne(arr)` from `lib/typeUtils.ts` instead of `arr.length > 0` — it narrows `T[]` to `NonEmptyArray<T>`, eliminating `arr[0]!` assertions. Use `NonEmptyString` (same file) for strings known to be non-empty.
- **Generated files are exempt and never hand-edited**: `client/src/routeTree.gen.ts` (TanStack Router; Biome ignores it) and every `*.css.d.ts` (rewritten by `generate-typed-css-modules`). Do not flag violations inside them; fix the source they are generated from.

### Lint suppressions

A `biome-ignore` is a documented exception, never a shortcut to a green turn: it names the narrowest rule, carries the reason on the same line, and is written only when the code cannot reasonably be restructured. The accepted cases in this repo are bracket access on index-signature types in tests (`useLiteralKeys`), a context whose non-null default is provably safe, a scrollable region made focusable so keyboard users can scroll it (`noNoninteractiveTabindex` — WCAG scrollable-region-focusable outranks the lint), and a non-control wrapper that delegates its children's keyboard events through a React handler (`noStaticElementInteractions`, e.g. the item editor's shortcut scope). A wrapper that groups a field with its own buttons is not an exception: make it a labelled `<fieldset>`. `useExhaustiveDependencies` is never suppressed — see `client/CLAUDE.md` § React.

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

### Abstraction: name concepts, don't count repetitions

Extract code into a function, hook, generator or component when it embodies a **concept worth naming** — a unit of meaning a reader grasps from the name alone, so the calling code reads as a sentence instead of making the reader re-derive the logic. That is the purpose of abstraction: not avoiding repetition, but giving each piece of logic its own identity.

This cuts in three directions:

- **Extract even a single occurrence** when naming it makes the caller read better — a predicate like `isHiddenByTickler(item, today)` beats an inline three-clause boolean, even if it appears exactly once.
- **Extract to separate layers of concern**, even with zero repetition. A loop that interleaves business logic with mechanics — pagination, retries, batching, rate-limiting — is two concepts fused; pull the mechanics into a named abstraction so the remaining code is pure logic and each piece reads at a single level. Canonical shapes:
  - Pagination/streaming → an async generator (the caller just `for await`s; cursor handling is hidden).
  - Rate-limiting/debouncing/retries → a decorator/wrapper function, not inline `setTimeout` logic.
  - A function mixing orchestration with low-level implementation details → extract the lower-level concerns into named helpers.
- **Don't extract code that is already its own best expression.** If the inline code is short and self-evident, wrapping it in a parameterized helper adds indirection without adding meaning. A name must compress; if reading the call site still requires jumping to the definition, the abstraction failed.

Repetition is a *signal*, not a rule. Repeated code suggests a concept may be hiding there — merge the copies only if you can give the result an honest name. If the best name available is vague (`processData`, `handleItem`) or the helper needs flags to serve all its callers, the copies are similar by coincidence, not by concept; leave them duplicated until the real concept emerges.

### Functional Programming
- Prefer pure functions, immutability, and function composition over imperative mutation.
- Prefer declarative array methods (`filter`, `map`, `flatMap`, `reduce`) over imperative `for`/`forEach` loops that push into a mutable accumulator. A loop that builds up an array by pushing is a signal to reach for `map`/`flatMap` instead.

### Patterns
- Identify where established patterns (factory, strategy, decorator, observer, repository) would reduce complexity or improve extensibility.
- Flag anti-patterns: god functions, boolean traps, deeply nested conditionals, primitive obsession.

### Dates
- Use `dayjs` for all date parsing, formatting, manipulation, duration arithmetic, and timestamp comparisons. Do not use the native `Date` API or other date libraries.
- **Exception — mongosh.** A one-off mongosh query or runner loads no npm packages, and a query on a BSON `Date` field needs `Date` bounds, so native `Date` is correct there. Say so in a one-line comment where the `Date` is built.

### Logging

Both packages log with `console.*`. On the server those lines reach Cloud Logging through Cloud Run, which stamps stderr lines as `ERROR` — Node writes `console.warn` **and** `console.error` to stderr — and stdout lines (`console.log` / `console.info`) as informational, unless the line is JSON carrying its own `severity` (the per-request lines from `lib/v1Logger.ts` are the only structured ones so far). Severity filters key off that, so:

- **Classify by what actually happened, not by where the code sits.** An *expected* outcome — a validation rejection, a 4xx, an idempotent replay, a skipped duplicate, a push against a `suspended` integration, a user with nothing to sweep — is normal behavior, not an error; record it with `console.log` if a record is needed at all. `console.error` / `console.warn` are for genuine failures.
- **Watch the catch-all trap.** A `throw` for an expected denial that lands in a surrounding `try/catch` gets error-logged by the catch, turning routine denials into recurring error noise. Hoist the guard above the `try`, or special-case the expected exception in the catch, so only real failures are error-logged.
- **Emit an error or warning only when it is actionable.** A line that fires routinely erodes the channel; delete it or demote it.
- **Structure: `[scope]` prefix, structured metadata object last** — `console.error('[apiTokens] touchLastUsed failed', { tokenId, err })`. Identifiers (ids, route, status, counts, durations) go in the object, never interpolated into prose.
- **Never log user content or secrets.** The privacy policy describes server logs as holding route, timing, status and identifiers — never item titles or notes, calendar event summaries, locations, attendees, email addresses, session tokens or OAuth credentials. `api-server/src/tests/logRedaction.test.ts` scans every `console.*` call in request-serving code and fails on an interpolated content field; whole error objects are scrubbed by `lib/googleErrorRedactor.ts`. Operator CLIs under `src/scripts/` are exempt because they print to a terminal.

### Tests — tests dictate behavior (TDD)

Tests are written **before** the implementation and serve as its specification. Lint/typecheck/existing tests passing is not enough.

- **Test-first per feature.** Before implementing, write the tests describing the planned behavior, watch them fail, then implement until green. Do not write the implementation and back-fill tests. A test that never failed proves nothing — if a fix lands before its test, revert the fix once to prove the test discriminates.
- **Every logic gets a test.** Any function with branching, computation or transformation has unit tests. Pure wiring (re-exports, trivial delegation) is exempt.
- **Layered coverage — every layer that applies to the change is mandatory; they are not alternatives:**
  - **Unit** — Vitest, fast and isolated (`src/tests/` in api-server and client).
  - **Integration** — modules tested in-process with their real collaborators, only true externals faked: an api-server route test runs the Hono handler through the real DAO against the per-file Mongo database; a client db-helper test runs against `fake-indexeddb`.
  - **E2E** — every user-visible or cross-surface change gets a Playwright spec in `e2e/` (drives the real client + API).
  - **Stories** — every visual state of a component has a story (`client/CLAUDE.md` § Storybook).
- **Untested legacy code: pin first.** Before modifying logic that has no tests, write characterization tests for its current behavior, then change it test-first.
- **Mock boundaries only.** Fake network (Google, Anthropic — the api-server harness already aborts outbound HTTP), time (`vi.useFakeTimers` / `vi.setSystemTime`), randomness and environment (`vi.stubEnv`). Never mock internal modules — a test that needs `vi.mock` on a sibling module is exposing a design problem; refactor instead. (In api-server such a file is also forced into the slower `isolated` vitest project.)
- Test code is held to the same standards as production code: setup in named helpers, arrange/act/assert readable in isolation, behavior specified rather than implementation mirrored.

### Same-change registries

Several catalogs describe the system to tooling, operators or users; adding a thing without its catalog entry ships a thing nobody can see. Update the catalog **in the same change**:

| When you add or rename… | Also update |
|---|---|
| A server env var | `api-server/src/env.d.ts` (typed access), `api-server/.env.example`, `api-server/README.md` § Environment Variables, the Secrets/Variables tables in `docs/gcp-deploy-plan.md`, and the GitHub environment itself — the deploy writes the **full** set, so a secret missing there deploys as an empty string |
| A collection, or a field holding a credential/token/secret | `api-server/src/lib/userDataInventory.ts` — deletion + export scope (§ User data scope above) |
| A public field on an item or routine | the `PUBLIC_FIELDS` allowlist in `api-server/src/routes/v1/projections/` and `docs/PUBLIC_API.md` |
| An MCP tool or its schema | both copies — `mcp-server/src/tools/` (source of truth) and `api-server/src/mcp/tools/` — `api-server/src/tests/mcpToolParity.test.ts` fails when the exposed tool sets drift |
| A synced entity | `client/src/db/syncHelpers.ts` + the IDB store + the op snapshot schema (§ Key Types above) |
| A periodic job | a Cloud Scheduler job documented in `docs/gcp-deploy-plan.md` — no in-process timers |
| A route | its `useDocumentTitle` + `client/src/tests/pageTitle.test.ts` (nav-label parity) |

## Post-Change Checklist

After any code change — bug fix, feature, or refactor — run the following cycle for each affected project. **Repeat from step 1 until every step passes.**

**Client changes:**
1. `cd client && npm run generate-typed-css-modules` — regenerates `.d.ts` files for CSS Modules
2. `npm run lint:fix` — Biome format + lint (may auto-correct files; subsequent steps run on the corrected state)
3. `npm run lint:css` — stylelint token gate on CSS Modules (`client/stylelint.config.js`); has no autofix
4. `npm run typecheck`
5. `npm run test`
6. Invoke the `client-code-reviewer` subagent (canonical source: `client/.claude/agents/code-reviewer.md`)

**API server changes:**
1. `cd api-server && npm run lint:fix` — Biome format + lint
2. `npm run typecheck`
3. `npm run test`
4. Invoke the `api-code-reviewer` subagent (canonical source: `api-server/.claude/agents/code-reviewer.md`)

**E2E changes (any file under `e2e/`):**
1. `cd e2e && npm run lint:fix`
2. `npx playwright test <changed specs>` — only specs that actually changed; full suite is too slow for the inner loop

A stop hook (`scripts/post-change-checks.sh`) runs the client / api-server / e2e blocks **in parallel** after each Claude response. It exits 2 (blocking) on any failure so Claude is automatically re-invoked until everything is green. It skips entirely unless a PostToolUse hook wrote the `.claude/.edited-this-turn` sentinel (one edited path per line) — a manual rerun after the sentinel is consumed is a silent no-op.

- **90-second cap.** Every block runs under one wall-clock budget (`GTD_HOOK_BUDGET_SECONDS`, default 90). A block that hits it is killed with its whole process group and reported as a failure. A healthy run takes about 20s (client ≈ 20s, one e2e spec ≈ 15s), so a timeout means something is broken — most often a stopped `gtd-test-mongo` container (every API write then 500s and each e2e test fails slowly), a spec that grew too big, or lost concurrency. Fix the cause; do not raise the budget.
- **E2E runs only the specs edited this turn**, not every spec in the uncommitted diff (which on a long branch would rerun the same specs every turn). The client and api-server blocks still key off the whole diff, so edits made through shell commands are checked too.

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

The two reviewers are kept separate because they encode different stack-specific knowledge (React 19/Base UI/IDB vs. Hono/MongoDB/Better Auth). Each canonical definition lives next to the code it reviews (`client/.claude/agents/code-reviewer.md`, `api-server/.claude/agents/code-reviewer.md`).

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
- CI (`.github/workflows/ci.yml`, on push to `main` and PRs) runs **only** the api-server typecheck/lint/test against a Mongo service container. Client, e2e and mcp-server checks run locally through the stop hook, not in CI. CI uses `npm install`, not `npm ci`, because macOS-generated lock files record unresolved optional WASM peers that `npm ci` rejects.

`gh` write operations on this repo need the active account `yuval-yssak` (not `yuval-winn-ai`). A working `git push` does not imply `gh` is on the right account.

### GitHub Environments

Configured at https://github.com/yuval-yssak/gtd-app/settings/environments — two environments (`production`, `staging`), each holding its own GCP secrets and vars. The workflow selects one by branch name (push) or `inputs.environment` (manual dispatch).

### Infrastructure

- **Backend**: Google Cloud Run, region `us-central1`, `--max-instances=1` and scales to zero — **no in-process timers**; anything periodic is a Cloud Scheduler job hitting an endpoint with the `x-cron-secret` header (value = `CRON_SECRET`).
- **API proxy**: Cloudflare Worker (`workers/api-proxy/`) routes both API domains to the respective Cloud Run service. The free tier's daily request limit can take staging offline; bypass via the raw Cloud Run URL + bearer token. **Cloudflare replaces any origin `502`/`504` with its own HTML error page — no CORS headers, no JSON** — so the browser sees "Failed to fetch" and API callers lose the error `code`. The API therefore never returns 502/504: use `503` for an unavailable upstream (Google, Anthropic) or a timeout, `500` for an unexpected failure, a `4xx` otherwise. `api-server/src/tests/noGatewayStatusCodes.test.ts` enforces it. The one 504 the code can't prevent is Cloud Run's own request timeout, so keep handler budgets well under it.
- **Docker images**: built from `api-server/Dockerfile` (build context is the repo root) and pushed to Google Artifact Registry.
- Full runbook, env-var inventory and Scheduler job setup: [`docs/gcp-deploy-plan.md`](docs/gcp-deploy-plan.md).

### Branch topology

`production` is an **unrelated history** that `main` supersedes (no merge-base). `staging` re-diverges from `main` because integration uses merge commits. `staging` and `production` carry classic branch protection with `allow_force_pushes: false` — the approved procedure is toggle it true, push with `--force-with-lease`, then restore false, sending the FULL config on the PUT.

### Service Worker (PWA)

The client is a PWA using `vite-plugin-pwa` with `strategies: 'injectManifest'` and a hand-written Service Worker at `client/src/serviceWorker.ts` (`client/vite.config.ts`). With `injectManifest`, **the `workbox:` option block is silently ignored** — precache globs must go under `injectManifest:`, or fonts fall out of the manifest and the offline shell cannot render.

`registerType: 'autoUpdate'` means the new SW activates immediately and takes over all open tabs, so **users need to reload once** to run the new JS/CSS. Known risk: a user offline at activation may have old JS lazy-load chunk URLs that are no longer precached, breaking the page until reload — inherent to `skipWaiting` in an offline-first app.

For development/debugging: DevTools → Application → Service Workers → "Update on reload".
