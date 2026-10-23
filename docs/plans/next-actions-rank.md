# Next Actions priority order — fractional rank + native drag and drop

Status: **implemented on `feat/next-actions-rank`, both reviewer subagents Approved, awaiting human review** (2026-10-23; all four phases,
unit + Playwright coverage, backfill script `api-server/src/scripts/backfillItemRanks.ts`). Branch:
`feat/next-actions-rank` off `main`; ships `main` → `staging` → `production`. Implementation notes
that deviate from the text below: the drag hook is `client/src/hooks/useNextActionsDrag.ts` (one
page-level hook for all sections, not a per-section `useSortableSection`); an expanded inline-editor
row is a normal neighbour (its row rect excludes the editor panel); `fractional-indexing@4.0.0`
throws only on EQUAL keys and returns an out-of-range key for an inverted pair, so the
`ensureSectionRanked` guard is what keeps `rankBetween` inputs ordered — implemented as `ensureRunRanked`, which
re-keys only the minimal non-increasing run around the drop (equal keys across two accounts' keyspaces are the
normal case in a merged list, so a whole-section re-key would be the common path), over the FULL day section read
from IndexedDB (hidden/filtered rows share the keyspace). Commits carry neighbour ids, not indexes. Clarifying an
`inbox` item into `nextAction` always mints a fresh top key (client + server); other transitions keep the key.
The backfill skips a user with ANY ranked row unless `--force`, guards every write on the planned `updatedTs`/status,
and never writes `expectedBy: null`. `rank` is schema-refined to a well-formed key. Each phase ends with
the repo checklist green (lint:fix → typecheck → test → reviewer subagent, unit **and** Playwright
coverage) and waits for explicit commit approval. All six open decisions are answered inline below;
a new session starts at Phase 1. Revision 2 folds in a 23-finding adversarial review; every
finding that changed the design is marked "(review)" where it lands.

## Context for a fresh session

This file is self-contained. Nothing below depends on the conversation that produced it.

- Repo rules: root `CLAUDE.md` (post-change checklist, the two mandatory reviewer subagents, no
  commit without approval), `client/CLAUDE.md`, `api-server/CLAUDE.md`. In particular: **op snapshot
  schemas must stay a strict superset of the entity interface** (a narrower schema 400s `/sync/push`
  and jams the client queue); **op identity is stamped at insert time** (`lib/opIdentity.ts`,
  `toServerOperation`); and **every implementation step adds unit + e2e coverage**.
- Prerequisites to run the checks: API tests need a local Mongo
  (`docker run -d --rm --name gtd-test-mongo -p 27017:27017 mongo:8.0`); Playwright starts the API
  with `TZ=UTC BRIEF_FAKE_MODEL=1` and reuses an already-running server **with its own env**, so
  restart any dev server under those vars first; check `lsof -i :4000 -i :4173` before a run. If
  working in a worktree, `./scripts/setup-worktree.sh` copies the gitignored `.env` files. The stop
  hook (`scripts/post-change-checks.sh`) runs the client / api / e2e checks after every response.
  Client unit tests run under vitest `environment: 'node'` with no jsdom or testing-library; `.tsx`
  tests use `renderToStaticMarkup`. Playwright has a single Chromium project.
- Today's state. `/next-actions` (`client/src/routes/_authenticated/next-actions.tsx`) renders a
  flat list inside `virtua`'s `WindowVirtualizer` (rows outside the viewport are **unmounted**),
  each row wrapped in `ListRowShell` (Collapse + `data-list-item-id` anchor for
  `useListScrollRestoration`), with `useListGhosts` keeping just-removed rows visible for a beat.
  Rows are a MUI `ListItem` whose `ListItemButton` (`role="button"`, click opens the inline editor
  via `editor.openEditor`, `editor.renderExpandFor(item._id)` renders it under the row) and whose
  `secondaryAction` holds copy-id / edit / done buttons. Sort is `compareNextActions`
  (`client/src/lib/compareNextActions.ts`): `focus` first, then "has `expectedBy`" before undated,
  then `expectedBy` ascending via `localeCompare`, and **`return 0` for everything else** (the
  input order is IndexedDB's `userId` index order, i.e. by `_id`, not insertion time). The Weekly
  Review walks the same comparator (`reviewFlowState.ts` → `stageEligibleItems`, case
  `nextActions`). No manual ordering exists anywhere and no drag library is installed.
- Sync facts the design leans on. Server apply is a whole-document `replaceById`
  (`api-server/src/lib/applyEntityOp.ts`); LWW is `existing.updatedTs <= incoming.updatedTs`
  (ties go to the incoming snapshot, same on the client in `client/src/db/syncHelpers.ts`). Every
  server write path — `/sync/push`, v1 PATCH, `/v1/operations/batch`, routine generation,
  `ownerMove` — funnels through `stampSnapshot` in `api-server/src/lib/applyOperation.ts`.
  Server-owned calendar fields survive rank-less client snapshots only through
  `lib/calendarLinkCarryForward.ts` (+ client `db/calendarLinkMerge.ts`,
  `mergeServerOwnedFieldsIntoNewerRow` in `syncHelpers.ts`), and that hydrator returns the incoming
  snapshot untouched for every detach status including `nextAction`, so it **cannot** be reused for
  `rank`. `/sync/pull` tolerates a 5 s cursor holdback (`CURSOR_HOLDBACK_SECONDS`, `routes/sync.ts`).
- `focus?: boolean` today: `ItemInterface` (`api-server/src/types/entities.ts:150`),
  `RoutineInterface.template` (`:214`), both op snapshot schemas (`schemas/operations/item.ts`,
  `routine.ts`), `STATUS_SPECIFIC_FIELDS` + `STATUS_FIELD_MATRIX` (item.ts), client mirrors
  (`client/src/types/MyDB.ts`), public API (`routes/v1/items.ts` `PATCH_WRITABLE_FIELDS`,
  `routes/v1/projections/item.ts` `PUBLIC_FIELDS`, `docs/PUBLIC_API.md:152,386,405` — three concrete
  field lists), hosted MCP tools (`api-server/src/mcp/tools/{items,routines}.ts`), local MCP
  (`mcp-server/src/tools/{items,routines}.ts`, `mcp-server/src/tests/tools.test.ts:173`), the
  superseded `tools/mcp-gtd/src/index.ts:120` + `gtdClient.ts:97` (must stay buildable;
  `e2e/mcp-server.spec.ts` spawns it), reassign (`lib/reassignEntity.ts:52,357` — a whitelist of
  dialog edits; the move itself spreads `{ ...item }`), routine template merge
  (`lib/routineOpenItemMerge.ts`, both sides), `client/src/db/itemHelpers.ts:44,61`
  (`NextActionFilters.focus` + `itemHelpers.test.ts`), `client/src/components/clarify/routineClarify.ts:39`,
  item editor (`clarify/NextActionFields.tsx` "In focus" checkbox, `clarify/types.ts`,
  `editItemDialogLogic.ts`, `itemEditor/itemEditorLiveMerge.ts:76,122`), routine editor
  (`routineEditor/RoutineScheduleFields.tsx`, `routineFormState.ts`, `RoutineEditorBody.tsx`),
  Next Actions row (`FocusIndicator`, testid `focusIndicator`), the four `db/itemMutations.ts`
  strip lists, `docs/DATA_MODEL.md:129,227,335`, `client/src/legal/privacy-policy.md:9`,
  `client/src/test-utils/storybookMocks.ts:87,168,179`, and specs `e2e/next-actions-sort.spec.ts`,
  `e2e/next-actions-filters.spec.ts`, `e2e/weekly-review.spec.ts` (stage-order test),
  `e2e/edit-item-cross-account-reassign.spec.ts`. **Do not touch** the Weekly Review's
  `kind: 'focus'` stage, `FocusStage.tsx`, or the `focusStage` / `focusKeep` / `focusDone` test ids —
  same word, unrelated concept. `api-server/README.md` and `client/src/db/devTools.ts` do not
  mention the flag.
  Routine-generated nextAction items already carry `expectedBy` + `ignoreBefore` (the due date), so
  the template's `focus` added nothing a date-first sort does not already give.
- Item creation paths. Server: `routes/v1/items.ts` (`persistNewInboxItem`, also the MCP capture
  path), `lib/routineItemGeneration.ts` (`buildRoutineItemSnapshot` → `publishRoutineItem`),
  `lib/routineItemRegeneration.ts` (`insertFreshOccurrence`, calendar items), `routes/calendar.ts`
  (three inbound GCal inserts, calendar items), `/v1/operations/batch` creates (caller-supplied full
  snapshots), `/sync/push` creates, `scripts/importFacileThings.ts`. Client: `db/itemMutations.ts`
  (`collectItem`), `db/routineItemHelpers.ts` (three creates + `restoreTrashedRoutineItem`).
- E2E drives the client through `window.__gtd` (`client/src/db/devTools.ts`, mounted in dev) via
  `e2e/helpers/gtd.ts` (`queuedOps`, `flush`, `listItems`, `clarifyToNextAction`…);
  `withTwoLoggedInDevices` lives in `e2e/helpers/context.ts`; a phone-viewport + `hasTouch` pattern
  exists in `e2e/date-field-controls.spec.ts`.
- Mirrored client/server modules follow the `briefSource.ts` pattern: logic-mirrored files with a
  parity fixture test on each side.
- Production has two real users (personal + work). Staging is frozen. This repo has had incidents
  of ops sitting queued on a device for a long time (hung Service Worker flush), and of the op log
  bloating a 512 MB Atlas tier — the backfill design below is shaped by both.

## The model (decided)

**Date is a gate, rank is the order inside it.**

- New field `rank?: string` on items — a fractional-indexing key
  (`fractional-indexing@4.0.0`, ESM, `generateKeyBetween` / `generateNKeysBetween`, base-62
  alphabet `0-9A-Za-z`). Both packages are `"type": "module"`; the api-server is NodeNext, the
  client is bundler resolution — the package works in both unchanged. `generateKeyBetween(a, b)`
  **throws when `a >= b`**; every caller below guards for that (review #1).
- `rank` is **universal** (not status-gated, like `title`): minted when an item is created on the
  paths listed in Phase 1, kept across every status change, never cleared. "Absent" therefore always
  means "not minted yet / not pulled yet", never "cleared" — that is what makes the carry-forward in
  Phase 1 step 7 safe. A move writes **one field on one item** = one sync op.
- Sort for Next Actions (page + weekly review), replacing the four tiers. Define
  `expectedDayKey(item) = item.expectedBy ? dayjs(item.expectedBy).format('YYYY-MM-DD') : null`
  (`expectedBy` is `isoDateOrDateTime`; the MCP documents both forms; date-only strings pass through
  unchanged) (review #7). Then:
  1. `expectedDayKey` ascending, `null` last;
  2. inside equal day keys: items **without** a rank first, newest `createdTs` first — an item from
     a pre-rollout client or from `/v1/operations/batch` is "new" and lands where a fresh item lands;
  3. then `rank` ascending by **code-unit comparison** (`a < b ? -1 : a > b ? 1 : 0`), never
     `localeCompare` — ICU collation sorts `a0` before `B0`, the alphabet is ASCII-ordered (review #8);
  4. `_id` ascending breaks **every** tie (equal ranks, same-ms `createdTs`), so the order is total
     and never flickers.
- The list is rendered in **sections**, one per distinct `expectedDayKey` plus "No date". Headers
  read "Overdue · Mon Oct 20", "Today", "Tomorrow", "Thu Oct 30", "No date".
- **Drag never changes the date.** Dragging is constrained to the item's own section; a drop
  outside snaps back. `expectedBy` changes only through the date field / explicit actions.
- Every creation path listed in Phase 1 mints a rank **above every existing rank of that user**:
  `generateKeyBetween(null, minExistingRankForUser)`. Because keys only compete inside one day key,
  that places the item at the top of whatever section it belongs to — among that user's rows; in
  the merged multi-account list another account's rows may still sit above it (review #23).
  Prepends shorten the integer head and grow only logarithmically (62, 3844, … prepends per
  character); midpoint inserts grow by about one character each.
- The merged multi-account page: keys from different accounts are plain strings and compare fine; a
  drag writes only the dragged item (its own `userId`); a neighbour from the other account is a
  valid neighbour for minting.
- `focus` is **removed** from items and routine templates. The op schemas keep accepting it as a
  deprecated, ignored field (same reason `briefStale` is accepted: old clients still send it and a
  strict schema would jam their queue); it is stripped in `stampSnapshot` so neither the row nor
  the op log carries it (review #6). The public API and MCP accept-and-drop it (D2).
- Drag and drop is **native Pointer Events**, no library (see "Drag design").
- No jitter in key generation. Equal keys are expected (two offline devices minting the same "top"
  key; a rebalanced section restarting at `a0` next to another section's `a0`); rule 4 orders
  them, and the section is re-keyed before any mint that would see `above.rank >= below.rank`
  (Phase 3 step 4).
- Consequence of per-day comparison: when an item's date changes it lands in its new section at a
  deterministic but not meaningful place. "Move to top" is one gesture away.

## Open decisions — answered

**D1. Migrating currently focused items.** After the backfill every open item has a rank in its
current display order. Focused items without a date would sit at the top of "No date", below every
dated item.
- (a) Leave them there. (b) Stamp `expectedBy = today` on focused undated items.

> Answer: **(b) Stamp today.** Scope (review #15): only `status: 'nextAction'` rows (`focus` is also
> persisted on done/trash rows); a tickler-hidden row (`ignoreBefore` after today) gets
> `expectedBy = ignoreBefore` instead, so it surfaces as "Today" on its wake day rather than
> already overdue. Focused items that already have a date keep it.

**D2. Public API `focus` on PATCH / MCP `gtd_update_item`.** `PUBLIC_API.md` says breaking changes
ship as `/v2`.
- (a) Accept and silently drop; `rank` read-only in responses. (b) Reject with `forbidden_field`.

> Answer: **(a) Accept and drop.** Implementation note (review #14): `rejectPatchBody` 400s any key
> outside `PATCH_WRITABLE_FIELDS` and `PATCH_CLEARABLE_FIELDS` derives from it, so `focus` stays in
> the writable set and is deleted from both `assignments` and `clearedFields` after
> `partitionPatchBody` — `focus: null` is a no-op too, not `not_clearable`. `rank` on PATCH is
> forbidden by default (not in the writable set). `/v1/operations/batch` may set `rank` (it only
> rejects `BATCH_FORBIDDEN_SNAPSHOT_FIELDS`; `rank` is in `PUBLIC_FIELDS`, so a get→batch-update
> echo must round-trip it) — allowed deliberately, same trust as `/sync/push`; document it.

**D3. Overdue sections.** (a) One section per past date. (b) One merged "Overdue" section.

> Answer: **(a) One section per date**, header prefixed "Overdue ·" in the error colour.

**D4. Mobile drag initiation.** (a) Long-press ≈ 250 ms on an always-visible handle. (b) A
"Reorder" toggle.

> Answer: **(a) Long-press on an always-visible handle.**

**D5. Dragging under active filters / search.** (a) Allow; key minted between the visible
neighbours. (b) Disable while filtered.

> Answer: **(a) Allow.**

**D6. Keyboard nudges.** (a) Both `Alt+↑/↓` instant nudge and grab mode. (b) Grab mode only.

> Answer: **(a) Both.**

## Drag design (native)

Scope that makes native viable: vertical only, one section at a time, handle-initiated, single
item.

- **Pure core** `client/src/lib/dragReorder.ts` (review #9: no jsdom here, so the logic is a
  reducer, not a DOM hook): `dragReducer(state, event) → { state, effects }` over events `lift`,
  `move(pointerY)`, `rectsChanged(rects)`, `drop`, `cancel`, `nudge(±1)`; helpers
  `computeDropIndex(pointerY, rowRects)`, `shiftFor(fromIndex, toIndex, draggedHeight)`,
  `neighboursAt(sectionItems, fromIndex, toIndex)` → `{ above, below }` skipping the dragged item,
  ghost rows and a row with the inline editor expanded. Fully unit-tested in node.
- **Hook** `client/src/hooks/useSortableSection.ts` is thin DOM glue, proven by Playwright only:
  `pointerdown` on the handle → `setPointerCapture`, `stopPropagation`; touch starts only after the
  long-press timer (D4), cancelled by `pointermove` > 8 px or `pointerup`. `pointermove`
  (rAF-throttled) re-reads the **mounted** rows' `getBoundingClientRect()` for the section — virtua
  unmounts rows outside the viewport, so a one-time snapshot goes stale on every range change; the
  pointer is always over mounted rows, so the drop index is always resolvable from them
  (review #11). Displaced rows shift by the dragged row's **own** height (rows are variable height:
  tag row, expanded editor) (review #10). `pointerup` commits; `pointercancel` / Escape snap back.
  Transforms go on the row content inside `ListRowShell`, never on virtua's positioned wrapper.
- **Handle placement** (review #10): a real `<button>` rendered as a **sibling** of
  `ListItemButton` inside `ListItem` (a leading counterpart to `secondaryAction`), not nested
  inside the row button — nested interactive content is invalid ARIA and the row's TouchRipple and
  `click` would fire on every drop. A capture-phase one-shot swallows the `click` that follows a
  completed drag so the editor never opens on drop.
- **Auto-scroll:** within 48 px of the viewport top/bottom, scroll the window in a
  `requestAnimationFrame` loop; the per-move rect re-read covers rows that mount meanwhile. Grab
  mode moving beyond the viewport uses `WindowVirtualizerHandle.scrollToIndex` (virtua 0.49 exposes
  `getItemOffset` / `scrollToIndex` on a ref).
- **Section wall:** rows outside the section dim while dragging; the drop index is clamped to the
  section; a release with the pointer outside the section's bounds snaps back.
- **Browser plumbing the hook owns:** `touch-action: none` on the handle only; `user-select: none`
  on `body` during a drag; `-webkit-touch-callout: none` + `contextmenu` prevented on the handle;
  `overscroll-behavior-y: contain` on the scroller; `navigator.vibrate(10)` on lift and on each slot
  change where supported.
- **Accessibility:** handle `<button aria-label="Reorder" aria-describedby=…>`; grab mode per D6
  (Space lifts, arrows move, Space commits, Escape cancels); `Alt+↑/↓` on the focused row commits
  one slot immediately; a visually hidden `aria-live="polite"` region announces "Moved <title> to
  position 3 of 8" / "Reorder cancelled".
- **One predicate for touch UI** (review #22): both the always-visible handle and the "Move to…"
  overflow use `(hover: none) and (pointer: coarse)` — CSS media query for the handle,
  `useMediaQuery` with the same string for the overflow — not `breakpoints.down('md')`.
- **Commit:** `reorderItem(db, item, { above, below })` (new, `db/itemMutations.ts`). Before
  minting it calls `ensureSectionRanked` (Phase 3 step 4) so `rankBetween` is never called with
  `above.rank >= below.rank` or with an unranked neighbour (review #1); then mints
  `rankBetween(above?.rank, below?.rank)`, writes through the existing put + `queueSyncOp` update
  path, then `refreshItems()`.

## Phase 1 — `rank` field end to end, including the carry-forward (no UI yet)

Server:
1. `npm i fractional-indexing@4.0.0` in `api-server/` and `client/`.
2. `api-server/src/lib/itemRank.ts` (mirror: `client/src/lib/itemRank.ts`): `rankBetween(a, b)`
   (throws through — callers guard), `topRank(minExisting)`, `evenlySpacedRanks(n)`,
   `compareRank(a, b)` (code-unit), `isRankTooLong(key)` (threshold 40 chars),
   `isStrictlyIncreasing(keys)`. Parity fixture test on both sides (`tests/itemRankParity.test.ts`),
   same fixture list, including the pair `['Zz', 'a0']` (review #8).
3. `ItemInterface.rank?: string` (+ comment: universal, never cleared, absent = not minted),
   `docs/DATA_MODEL.md` schema block. Op snapshot schema `rank: nonEmptyString.optional()` —
   universal, **not** in `STATUS_FIELD_MATRIX`.
4. `lib/topRankForUser.ts`: `itemsDAO.findOne({ user, rank: { $exists: true } }, { sort: { rank: 1 } })`
   → `topRank(min)`. Add the non-unique index `{ user: 1, rank: 1 }` in `itemsDAO.init` (boot-safe:
   only unique indexes can crash boot) and list it in `api-server/README.md` § Collections &
   Indexes. Test: returns `Zz` when `a0` also exists (binary order).
5. Mint on: `persistNewInboxItem` (v1 POST, covers MCP capture), `buildRoutineItemSnapshot` (pass the
   rank in; `ensureFirstRoutineItem` / `advanceRoutineAfterDisposal` resolve it),
   `scripts/importFacileThings.ts`. Calendar-status inserts (`insertFreshOccurrence`, the three in
   `routes/calendar.ts`) stay unranked. `/v1/operations/batch` and `/sync/push` creates are
   **deliberately un-minted** (caller-supplied snapshots; rule 2 places them on top) — say so in the
   code comment and `PUBLIC_API.md` (review #12).
6. Mint when an item **enters** `nextAction` without a rank on the server: v1 PATCH status change,
   the v1 clarify composite if separate. Reassign needs nothing — `applyItemEditPatch` spreads
   `{ ...item }` so `rank` rides along; add a test asserting a moved item keeps its `rank`
   (review #12).
7. **Rank carry-forward** (review #2). Apply is a whole-document replace, so any device that edits a
   row before pulling its rank (after the backfill, after another device's drag) would erase it.
   Add `lib/rankCarryForward.ts`: in `applyAndPublishOperation` next to the calendar hydration
   (reusing its single `findByOwnerAndId` read), if the incoming item snapshot lacks `rank` and the
   stored row has one, keep the stored value — status-independent. Client mirror in
   `mergeServerOwnedFieldsIntoNewerRow` (`syncHelpers.ts`): a losing pulled snapshot carrying a
   `rank` hands it to the newer local row that lacks one. Parity-pin the field list on both sides
   like `CALENDAR_LINK_FIELDS`. Tests: server apply of a rank-less newer snapshot keeps the stored
   rank; the recorded op's snapshot carries it; client pull of a losing snapshot merges it.
8. `routes/v1/projections/item.ts`: add `rank` to `PUBLIC_FIELDS`. `docs/PUBLIC_API.md`: item shape
   (`:152`), PATCH field list (`:386`, `rank` forbidden), batch note (rank settable, un-minted on
   create). `userDataInventory`: nothing to change (items export `full`; `rank` is not a secret) —
   state that in the commit message.

Client:
9. `StoredItem.rank?: string`; `syncApi.ts` item type.
10. `compareNextActions` → the four rules above over `expectedDayKey`. Tests: mixed `YYYY-MM-DD` and
    datetime `expectedBy` in both offset signs collapse to one day; `['Zz','a0']`; same-ms unranked
    items ordered by `_id`; `reviewFlowState.test.ts` ordering test; the comment in
    `waitingForGroups.ts`.
11. Mint in `collectItem`, the three `routineItemHelpers.ts` creates, and `clarifyToNextAction` when
    the item has no rank — `topRankForUser(db, userId)` over `getItemsByUser` (hundreds of rows is
    trivial; no IDB index). The status-transition helpers in `itemMutations.ts`,
    `applyNextActionForm`, `restoreTrashedRoutineItem` all spread `...rest`; `rank` must **not** join
    any strip list.
12. Reviewer subagents both sides; e2e: rewrite `e2e/next-actions-sort.spec.ts` to the new order
    (dated asc, then undated newest-first); a new item lands at the top of its section; an item
    created through `/v1/operations/batch` without a rank lands above ranked ones; a public-API case
    asserting `rank` on a created item and `forbidden_field` on PATCH.

## Phase 2 — remove `focus`, backfill script

1. Delete `focus` from every location in the inventory above (types both sides, `NextActionMeta`,
   `NextActionFormState` + `toItemFields`, `editItemDialogLogic.ts` strip list,
   `itemEditorLiveMerge.ts`, `routineFormState.ts`, `RoutineEditorBody.tsx`, both
   `routineOpenItemMerge.ts` `OPTIONAL_STAMPED_KEYS`, `reassignEntity.ts` patch, the four
   `itemMutations.ts` strip lists, `itemHelpers.ts` `NextActionFilters` + its test,
   `routineClarify.ts`, storybook mocks, `docs/DATA_MODEL.md` three spots, privacy policy wording
   "focus tags" → "priority order" (check whether the legal pages carry a "last updated" marker).
   Leave the Weekly Review's `focus` stage kind and test ids alone.
2. UI: remove the "In focus" checkboxes (`NextActionFields.tsx`, `RoutineScheduleFields.tsx`) and
   `FocusIndicator`; delete the `focusIndicator` assertions in `e2e/next-actions-filters.spec.ts`,
   `nextActionsFilters.test.tsx`, `nextActionFieldsDense.test.tsx`.
3. Op schemas: keep `focus: z.boolean().optional()` in the item schema and the routine template
   schema with a `briefStale`-style comment; remove `'focus'` from `STATUS_SPECIFIC_FIELDS` / matrix.
   Strip `focus` / `template.focus` in `stampSnapshot` (`applyOperation.ts`) — the one function every
   write path funnels through — so neither the row nor the recorded op carries it (review #6).
   Tests: `operationValidator.test.ts` accepts a snapshot with `focus`; a sync-push test asserts
   neither the items row nor the op log carries it afterwards.
4. Public API + MCP per D2: PATCH keeps `focus` writable-but-discarded (both `assignments` and
   `clearedFields`), `PUBLIC_FIELDS` drops it, hosted MCP + `mcp-server` zod schemas accept-and-drop,
   `mcp-server/src/tests/tools.test.ts`, `tools/mcp-gtd` untouched (its `focus` input now round-trips
   as a no-op — `e2e/mcp-server.spec.ts` `clarify_inbox_item` with `focus` must still pass),
   `docs/PUBLIC_API.md` three field lists + changelog note, `mcp-server/README.md` tool table.
5. `api-server/src/scripts/backfillItemRanks.ts` (`--user-email`, `--dry-run`, `--timezone <IANA>`
   default `Asia/Jerusalem`, `--force`). Per user (reviews #3, #4, #5, #15, #16):
   - Scope: rank **only `status: 'nextAction'` rows**. Done/trash/other rows get `$unset: { focus }`
     via `bulkWrite` with **no ops** (the schema still accepts `focus`; `stampSnapshot` strips any
     straggler) — ranking thousands of closed rows would bloat the op log and bootstrap.
   - D1 stamp first: `focus: true` + no `expectedBy` + `nextAction` → `expectedBy` = run day in
     `--timezone`, or `ignoreBefore` when that is later. These rows get a bumped `updatedTs` (their
     content changed).
   - Then order the nextAction rows by the **old** comparator (focus desc, dated before undated,
     `expectedBy` asc, `createdTs` desc, `_id`) and assign `evenlySpacedRanks(n)`; `$unset focus`.
   - Rank-only rows keep their **existing `updatedTs`** (do not bump): ties go to the incoming
     snapshot on both server and client, so every device applies the rank, while a device's older
     unpushed edit still wins on push and the Phase 1 carry-forward preserves the rank.
   - One `update` op per nextAction row, built per batch with `toServerOperation` /
     `allocateOpIdentity` immediately before `insertMany` (the `backfillCalendarInstanceEventIds.ts`
     pattern of `randomUUID` + one shared `nowIso` predates the op-identity rule and can be skipped
     by the 5 s pull holdback). deviceId `backfill:item-ranks`. Call `notifyChange` per op (or
     batch) so online tabs pull immediately rather than on their next cycle.
   - Idempotent: skip a user whose nextAction rows already all carry ranks unless `--force`.
   - Tests against a seeded DB: focused undated → dated today and ranked ahead of plain today rows
     (note: a focused row already dated today interleaves by `createdTs`, per the old comparator);
     tickler-hidden focused → `expectedBy = ignoreBefore`; focused done/trash → `focus` unset, no
     date, no rank, no op; plain rows → ranked `createdTs` desc inside their date group; rank-only
     rows keep `updatedTs`; after the backfill a pushed snapshot whose `updatedTs` predates it still
     applies **and** keeps the rank; rerun is a no-op without `--force`.
6. Reviewer subagents; e2e: `e2e/weekly-review.spec.ts` stage-order test and
   `e2e/edit-item-cross-account-reassign.spec.ts` lose `focus`; `e2e/next-actions-sort.spec.ts`
   final form.

**Deploy gate** (review #18): nothing deploys before Phase 2 is merged — Phase 1 alone would ship a
comparator that ignores a still-visible "In focus" checkbox. Rollout order is a hard step: API
first (its `.strict()` schema must accept `rank` before any new client pushes one, or the queue
jams), verified via `GET /version` on staging and production, then the client, then the backfill.
Old clients keep working against the new API (they spread `...rest` on edits; the carry-forward
covers the rank-less window).

## Phase 3 — sections + desktop drag and drop + keyboard

1. `client/src/lib/nextActionSections.ts` (pure): `groupIntoSections(sortedItems, todayIso)` →
   `{ dayKey, label, isOverdue, items }[]` over `expectedDayKey`. Unit tests incl. mixed
   date/datetime `expectedBy`, midnight roll (`useTodayIso` already re-renders the page).
2. `next-actions.tsx`: section header rows inside the `WindowVirtualizer` (headers are rows too),
   `data-testid="nextActionSectionHeader"`; keep `nextActionItemRow`; the drag handle
   (`nextActionDragHandle`) as a sibling of `ListItemButton` — visible on hover/focus with a
   pointer, always under the touch predicate; `data-section-key` + `data-item-id` attributes; a
   `ref` on the virtualizer for `scrollToIndex`.
3. `lib/dragReorder.ts` reducer + `hooks/useSortableSection.ts` glue + CSS module (`dragging`,
   `shifted`, `dimmedSection`, `liveRegion`). Reducer unit tests: lift, move past a midpoint, drop,
   cancel, clamp at section edge, drop outside snaps back, rects changing mid-drag (virtua range
   change), variable row heights, ghost and expanded rows skipped as neighbours.
4. `db/itemMutations.ts`: `reorderItem(db, item, { above, below })`;
   `ensureSectionRanked(db, sectionItems)` — fires when any row lacks a rank **or** the section's
   rank sequence is not strictly increasing in display order (equal keys from concurrent mints or a
   rebalance), re-keying the whole section in its current displayed order with `evenlySpacedRanks`
   (review #1); `rebalanceSection` when the minted key `isRankTooLong`. Both rewrite N rows with
   fresh `updatedTs`, which can beat a concurrent offline edit of a neighbour on another device —
   accepted, documented in the code, and kept rare (review #20). Tests: equal neighbours, inverted
   neighbours, `rankBetween` never called with `a >= b`, one op per move on the happy path.
5. Keyboard per D6 + live region. Expose `reorderItem` on `window.__gtd` and `e2e/helpers/gtd.ts`.
6. e2e `e2e/next-actions-reorder.spec.ts`: mouse drag (`mouse.down/move/up`) moves an undated item
   from 4th to 2nd, the order survives a reload **and** is pulled by a second logged-in device
   (`withTwoLoggedInDevices`); a drag across a section header snaps back and writes nothing
   (`queuedOps()` empty, `expectedBy` unchanged); a completed drop **does not open the editor**; a
   drag while another row's inline editor is expanded; keyboard grab + arrows + Space; `Alt+↑`;
   Escape cancels; filtered drag per D5; a drop between two rows that share a rank (seed via
   `/v1/operations/batch`) succeeds. Geometry assertions (row `getBoundingClientRect` order), not
   text only.
7. Reviewer subagent (client).

## Phase 4 — mobile

1. Long-press initiation per D4, haptics, auto-scroll near viewport edges, the browser plumbing
   list above.
2. "Move to…" bottom sheet (`components/nextActions/MoveToSheet.tsx`). Rows have no menu today; add
   an overflow (`MoreVert`) icon button in `secondaryAction` under the touch predicate
   (`data-testid="nextActionMoveToButton"`, sheet `nextActionMoveToSheet`): Top of section, Bottom
   of section, Above… / Below… with a searchable picker limited to the same section. Commits through
   `reorderItem`. Date is **not** offered here.
3. e2e at a phone viewport (`hasTouch: true`): drive the gesture with CDP `Input.dispatchTouchEvent`
   through `context.newCDPSession(page)` (Playwright's `touchscreen` only taps); a vertical swipe on
   the row body scrolls instead of dragging; the sheet path end to end.
4. Reviewer subagent (client).

## Out of scope (follow-ups, capture as GTD items)

- `POST /v1/items/:id/move` / MCP `gtd_move_item` so agents can prioritise with neighbours instead
  of raw keys.
- Binary-insertion placement gesture ("Which first?").
- Separate "when" vs "deadline" dates.

## Done criteria

- All four phases green under the stop hook; both reviewers "Approved" per phase; deploy gate above
  respected.
- Backfill on production, after the API + client deploy, per user:
  ```bash
  cd api-server
  MONGO_DB_URL="$(cat ~/.config/gtd/prod-mongo-uri)" MONGO_DB_NAME=gtdProdDB \
    npx tsx src/scripts/backfillItemRanks.ts --user-email <email> --dry-run
  ```
  Review the dry-run output, rerun without `--dry-run`, then verify in the browser: dated items in
  date order, focused undated items now under Today in their former order, undated items newest
  first (the old undated order was by `_id`, not insertion time, so it is not reproducible and not
  the target). Do not export those variables into a shell that later runs vitest.
- Memory note `project_next_actions_rank.md` with ship hashes.
