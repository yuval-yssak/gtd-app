# Item brief — implementation plan

Status: **draft for approval** (2026-09-20). Branch: `feat/item-brief` off `main`; phases ship
in order → `staging` → `main`. Each step ends with the repo checklist green (lint:fix → typecheck →
test → reviewer subagent) with unit + Playwright coverage, and waits for explicit commit approval.

## What we are building

A one-line **brief** per item: a review-oriented condensation of title + notes ("what this
commitment is and why it is still open"), shown in place of the long notes preview during the
Weekly Review. Structured fields (status, contexts, dates, energy…) are untouched.

Five ways a brief comes into existence, in priority order:

| # | Path | Role | Where |
|---|---|---|---|
| 1 | **Message Batches API** sweep | primary; all users, OPEN statuses only (see § Targeting scope); 50 % price | `lib/brief/briefBatch.ts`, `POST /maintenance/briefs/sweep` |
| 2 | **Cloud Scheduler** | drives #1 every 15 min (submit new batch + harvest ended ones) | GCP job → the sweep endpoint, cron-secret header |
| 3 | **On-demand generate** | user button (editor + review card), public API, MCP `gtd_generate_brief` | `POST /v1/items/:id/brief/generate` (direct `messages.create`) |
| 4 | **Write-path escape hatch** | inline generation right after an item write; **feature-flagged, off by default** | `applyOperation` post-write hook, `BRIEF_INLINE_ON_WRITE=1` |
| 5 | **Authored brief** | the user types it in the editor; Claude Code writes it via MCP `gtd_set_brief` | `PUT /v1/items/:id/brief` + client op |

## Decisions this plan is built on

| Topic | Decision |
|---|---|
| Field name | `brief` (avoid `summary`: it is GCal's word for the event *title* throughout the sync code) |
| Storage | **sidecar synced entity `itemBrief`**, `_id === item._id`, NOT a field on `items` — see "Why a sidecar" |
| Staleness | `sourceHash` of `title + '\n' + notes` stored on the brief; a model brief is shown only when it matches the item's current hash |
| Authored briefs | `origin: 'user' \| 'agent'` briefs are **pinned**: the sweeper never overwrites them; the UI shows them even when stale, with a subtle "notes changed since" marker; explicit Regenerate overrides |
| Skip rule | notes empty or `< 160` chars after trim → a `text: null, origin: 'skipped'` row is written **without a model call**, so the sweeper does not reselect it. Card then shows title only |
| Model | `BRIEF_MODEL = 'claude-haiku-4-5'` (open decision 1, answered "Haiku"); `CLAUDE_ASSIST_MODEL` stays `claude-sonnet-4-6` |
| Output | structured output `output_config.format` → `{ brief: string \| null }`, **soft** target 160 chars (never truncated server-side — an ellipsis would read as "summary incomplete, open the notes"), must abstract the notes as a whole rather than enumerate them, language of the notes, `max_tokens: 256`; system block carries `cache_control` but it is **inert on Haiku 4.5** (4096-token minimum cacheable prefix vs our ~642 — see `buildSystemBlocks`), notes treated as data (same injection guard wording as `agentLoop.ts`) |
| Visibility | device-local preference `showBriefs` (localStorage, same pattern as `lib/colorTheme.ts`), toggled in Settings and in the Weekly Review header; default **on** |
| Cron auth | the scheduler secret, renamed `CRON_SECRET` + `x-cron-secret` header (open decision 6) and shared through `auth/cronSecret.ts`; one new Cloud Scheduler job per environment |
| Hash function | `cyrb53`-style synchronous string hash mirrored server/client (`lib/briefSource.ts` ↔ `client/src/lib/briefSource.ts`) with a parity test; sha256 would force async hashing in render paths |

### Why a sidecar and not an item field

Every op is a full snapshot and `applyEntitySnapshotOp` replaces the whole row under LWW on
`updatedTs` (`lib/applyEntityOp.ts`). A server-generated brief written onto the item would have to
be an op with `updatedTs = now`, and:

- it beats any **offline edit** a device has not pushed yet (older `updatedTs`) — user content lost;
- the sweeper selects exactly the items **being edited** (hash mismatch is the trigger), so the
  server op racing the client's autosave is the common case, not the edge case;
- a Batches result can land **up to 24 h** after submission; the snapshot it was built from is
  long stale, so the write would need a compare-and-set on the item and still lose to the offline
  case above.

A sidecar entity has its own LWW, so an item edit and a brief write never contend. The client shows
a model brief only when `sourceHash` matches, so a stale brief degrades to the truncated notes
preview instead of showing a lie. Precedent: `reviewInbox` (0c2d7e3 server, ee5336d client).

## Ground truth that shapes the plan

- **Weekly Review cards ARE the item editor.** `ClarifyStage.tsx` and `FocusStage.tsx` render
  `ItemEditorBody` inline. One Brief section in `ItemEditorBody` serves the editor page, the
  dialog and the review card; the review-mode difference is presentation only (brief first,
  notes collapsed).
- **Notes preview is already capped** (ab3345b) in `itemEditor/NotesSection.tsx`; brief-first mode
  collapses it further to a "Show notes" disclosure.
- **Editor live-merge** (`itemEditor/itemEditorLiveMerge.ts`) merges remote changes into an open
  editor field-by-field. The brief text field joins `ItemFormSeeds` so a generated brief arriving
  by sync populates a clean field and never clobbers a dirty one.
- **Anthropic client exists**: `lib/claude/anthropicClient.ts` (lazy singleton, `maxRetries: 1`);
  `ANTHROPIC_API_KEY` is already wired in `deploy-api.yml` (line 88) for both environments.
  Structured-output pattern to copy: `lib/claude/agentLoop.ts` line 133–135.
- **Server-originated ops** go through `applyAndPublishOperation(userId, raw, { deviceId, now })`
  (`lib/applyOperation.ts`); callers today stamp `deviceId: 'api:<tokenId>'`. Brief writes will
  stamp `server:brief`, `server:brief-batch`, `server:brief-inline` so the op log says who wrote it.
- **New synced entity = client change too** (reviewer memory
  `project_new_synced_entity_wedges_old_clients.md`): `client/src/db/syncHelpers.ts` needs the
  `case 'itemBrief'` arm and the `EntityStoreName` union; the default branch already warns+skips,
  so pre-upgrade tabs do not wedge.
- **Cron pattern**: `POST /calendar/webhooks/renew` (`routes/calendar.ts` ~5901) checks the header
  inline; `docs/gcp-deploy-plan.md` § "Calendar webhook renewal" documents the Scheduler job. Cloud
  Run runs `--max-instances=1` and scales to zero, so no in-process timers.
- **Public API surface**: item projection allowlist `routes/v1/projections/item.ts`; scopes in
  `types/entities.ts` (`ApiTokenScope`); dual cookie-or-bearer auth in
  `auth/assistAuthMiddleware.ts` (`authenticateBearerOrSession`) is the pattern for the client
  button hitting a `/v1` route. Write bucket 60/min, read 600/min (`docs/PUBLIC_API.md`).
- **MCP tools** live twice: `api-server/src/mcp/tools/*.ts` (remote) copied from
  `mcp-server/src/tools/*.ts` (stdio), locked by `mcpToolParity.test.ts`. `SERVER_INSTRUCTIONS`
  in `mcp/registerTools.ts` mirrors `mcp-server/src/index.ts`.
- **e2e cannot reach Anthropic** (`e2e/claude-assist.spec.ts` header). Generation e2e needs a
  deterministic seam: `BRIEF_FAKE_MODEL=1` in the e2e API webServer makes the generator return the
  first sentence of the notes, prefixed `[fake]`. The real SDK call is unit-tested with `vi.mock`
  on `anthropicClient.js` exactly like `v1ClaudeAssist.test.ts`.
- **Bootstrap** (`routes/sync.ts` ~217–256) ships all entities in one JSON; `itemBriefs` joins the
  `Promise.all`. Bootstrap is already oversized (see `docs/plans/scalable-bootstrap-phases-0-1.md`);
  briefs add ≤ 200 bytes per item and are excluded for items outside the hot set once that plan lands.

---

## Data model

```ts
// api-server/src/types/entities.ts — mirrored as StoredItemBrief in client/src/types/MyDB.ts
export type BriefOrigin = 'model' | 'user' | 'agent' | 'skipped';

export interface ItemBriefInterface {
    _id?: string;           // === item._id (one-to-one; O(1) lookup in IDB and Mongo)
    user: string;
    itemId: string;         // duplicated for readability in queries and in the op log
    text: string | null;    // null only when origin === 'skipped'
    origin: BriefOrigin;
    sourceHash: string;     // briefSourceHash(item.title, item.notes) at generation/authoring time
    model?: string;         // model id for origin 'model'
    generatedTs: string;    // ISO datetime the text was produced
    createdTs: string;
    updatedTs: string;      // LWW anchor for THIS entity only
}
```

Collection `itemBriefs`, unique on `_id`, index `{ user: 1, sourceHash: 1 }`. Op schema
`schemas/operations/itemBrief.ts` — strict, a superset of the interface (lesson from the
`/sync/push` routine-schema jam). `EntityType` gains `'itemBrief'`; `EntitySnapshot` union gains
the interface.

**Lifecycle rules**

- Item hard-delete (`applyEntityOp` item `delete` arm, trash purge) → delete the brief row with a
  recorded `delete` op so devices drop it.
- Reassign (`lib/reassignEntity.ts` item arm) → delete the brief on the source user; the target's
  sweeper regenerates. No cross-user brief moves.
- Trash / done KEEP the briefs they already have, but are no longer targeted for new ones — see
  § Targeting scope below. A revived item finds its brief either still fresh or correctly stale.

**Derived view** (client and server share the rule, `lib/briefSource.ts`):

```
briefState(item, brief):
  none        — no row, or row.sourceHash ≠ hash && origin === 'model' | 'skipped'   → show notes preview
  fresh       — row.sourceHash === hash                                              → show brief
  pinnedStale — row.sourceHash ≠ hash && origin ∈ {user, agent}                      → show brief + "notes changed" marker
```

## Targeting scope

> **Decision changed 2026-09-21 — this reverses the original "all statuses" choice.**
>
> **Was:** the sweep targeted every status including `done` and `trash`, on the reasoning that the
> user had asked for all statuses and the archive pass could simply run after the live pass.
>
> **Now:** only the OPEN statuses are targeted — `inbox`, `nextAction`, `calendar`, `waitingFor`,
> `somedayMaybe` (`LIVE_STATUSES` in `lib/brief/briefScope.ts`).
>
> **Why:** a brief exists to condense an item's notes for the Weekly Review, and a done or trashed
> item is never reviewed — so a brief for one can never be read. The staging corpus made the cost
> concrete: 10 722 of 11 926 items are closed (done 6 269, trash 4 453), i.e. **90 % of everything
> the sweep walked**, and 2 711 briefs had already been generated for items nobody would review.
>
> **What did NOT change:** briefs already written for closed items are kept. They are paid for,
> they harm nothing, and an item revived from trash or reopened from done arrives with its brief
> either still fresh or correctly reading stale. There is deliberately no cleanup pass.
>
> The rule is enforced on every generation path — the batch sweep and `sweep-mine` through
> `isBriefTarget` / the page query's index bounds, and the inline hook and the on-demand endpoint
> through `planFromTarget`, which returns `not_briefable`. The on-demand endpoint answers
> **409 `brief_not_applicable`**, and `force` does not override it: a closed item is out of scope,
> not merely protected.

## Sweep selection

`findBriefTargets(limit)` — a bounded indexed lookup over `items`, NOT a scan.

> **Design changed 2026-09-21 — this reverses the original "store nothing on `items`" choice.**
>
> **Was:** "`sourceHash` cannot be indexed against a computed value, so we store nothing on
> `items`; the sweep fetches candidate items in `updatedTs DESC` pages, hashes in Node, and
> compares. On M0 with ≤ 10 k items per user this is a few hundred ms."
>
> **Why it failed:** it was not a few hundred ms. Selection re-derived the whole backlog from
> scratch on every 15-minute tick — 23 852 documents examined per tick on the staging corpus, ~12
> MB pulled from a throttled Atlas M0 — and then threw the result away whenever it found a batch
> already in flight. Measured latencies were 88 s–300 s with roughly half of all attempts hitting
> Cloud Run's 300 s ceiling as a 504; an 89 s run did literally zero work. The scheduler job had to
> be paused. Full measurements in `docs/gcp-deploy-plan.md` § Brief sweep.
>
> **Now:** a denormalised marker, `items.briefStale` (`lib/brief/briefStaleMarker.ts`), turns
> staleness into a database predicate:
>
> - **Maintained in `ItemsDAO`, not at call sites.** Item writes are spread over ~40 call sites
>   (`/sync/push`, the `/v1` routes, GCal inbound sync, the routine generator, the reference
>   cascades, reassign, the one-off scripts). A marker maintained there would rot the first time
>   one was added without it, and a missed one means an item that never gets a brief. The DAO
>   overrides `insertOne` / `insertMany` / `replaceById` / `replaceByOwner` / `updateOne` /
>   `updateMany` / `bulkWrite`, which makes it structurally unbypassable.
> - **Conservative.** Full-document writes mark unconditionally; partial updates mark when their
>   payload names `title`, `notes` or `status`. A false `true` costs one hash; a false `false`
>   would strand an item forever, so the two are not treated symmetrically. `status` is watched so
>   an item REVIVED to a live status becomes a target again without its content changing.
> - **Not an authority.** `briefWriter`'s compare-and-set still re-reads the item and hashes
>   title + notes for real. The marker only decides which items are LOOKED at; a denormalised
>   value can never wave through a brief whose item moved on.
> - **Tri-state**: `true` = needs a sweep, `false` = swept and settled, ABSENT = written before the
>   marker existed. Settling writes `false` rather than `$unset` so "absent" keeps meaning
>   "pre-dates the feature" — see the backfill below. The index `brief_stale_targets`
>   (`{user, briefStale, status}`) is partial on `briefStale: true`, so `false` costs a boolean on
>   disk and nothing in the index: the steady state still indexes zero keys and examines zero
>   documents.
> - **Settling is guarded on the item's CONTENT**, not on `updatedTs`. The sweep reads a page, then
>   round-trips to `itemBriefs` and hashes in Node before settling; a write landing in that window
>   would otherwise have its fresh mark erased, leaving current content with a stale brief and
>   nothing to bring it back. Comparing title/notes/status directly cannot be defeated by a writer
>   that forgets to bump the timestamp.
> - **Backfill** (`lib/brief/briefStaleBackfill.ts`, called from `mainLoader`): one server-side
>   `updateMany` over `{ briefStale: { $exists: false } }` marks every pre-marker item, so a
>   12 000-item corpus is repaired without a document crossing the wire. **Convergent, not merely
>   idempotent** — Cloud Run scales to zero and re-runs it on every cold start, so it must never
>   reclaim a settled item; that is precisely why settling writes `false` instead of removing the
>   field. The sweep then drains the backlog 2 000 at a time.
>
> **Measured on a seeded staging-shaped corpus** (11 926 items / 2 users / the real status mix):

| | documents examined per tick | wall time (local Mongo) |
|---|---|---|
| before | 23 852 | 180–220 ms local, 88–300 s on Atlas M0 |
| after, with work to do | 1 204 | 15–41 ms |
| after, steady state | **0** | 3 ms |

Selection returns rows where the brief is missing, or `brief.sourceHash ≠ hash(title, notes)` and
`brief.origin ∈ {model, skipped}`. Pinned (`user` / `agent`) rows are never targets. The hash is
still computed in Node — it cannot be a predicate — but only over the marked items, and the sweep
clears the marker on every item it examines and does not target, so the set drains to empty.
Capped at 2 000 targets per run.

---

# Phase 1 — sidecar entity, authored briefs, review presentation (no AI yet)

Ships standalone value: you can write a brief by hand or via Claude Code, and the review shows it.
Everything AI-related builds on this.

## 1.1 Server entity + sync

- `types/entities.ts`: `ItemBriefInterface`, `BriefOrigin`, `EntityType` + `EntitySnapshot` unions.
- `dataAccess/itemBriefsDAO.ts` (+ `loaders/mainLoader.ts` index creation, `routes/devLogin.ts` dev
  reset list).
- `schemas/operations/itemBrief.ts` + `index.ts` registration.
- `lib/applyEntityOp.ts`: `case 'itemBrief'` (plain snapshot LWW) and the item-delete cascade.
- `lib/reassignEntity.ts`: delete-on-source rule. `lib/syncDoctor.ts`: count the new collection.
- `routes/sync.ts`: bootstrap includes `itemBriefs`; pull/push accept the type.
- `lib/briefSource.ts`: `briefSourceHash`, `briefState`, `BRIEF_SKIP_MIN_NOTES_CHARS = 160`.
- `docs/DATA_MODEL.md`: new "Item briefs" section + schema reference entry.

Tests: `itemBriefSync.test.ts` modelled on `reviewInboxSync.test.ts` (push/pull round-trip, LWW,
delete cascade on item hard-delete, reassign drops the brief, bootstrap carries it, strict schema
rejects a snapshot with an unknown key and one missing `sourceHash`); `briefSource.test.ts` (hash
determinism, state table, skip threshold at 159/160 chars).

## 1.2 Public API + MCP (authored path)

- `PUT /v1/items/:id/brief` body `{ brief: string | null }` → writes `origin: 'agent'` for bearer
  callers, `'user'` for the session cookie; `null` deletes the row. Scope: `items.write`.
- `GET /v1/items/:id` and `GET /v1/items` projections gain a read-only nested
  `brief: { text, origin, state: 'fresh' | 'pinnedStale' | 'none', generatedTs } | null`.
- `GET /v1/items?briefState=none|pinnedStale` filter so an agent can sweep what is missing.
- `routes/v1/operations.ts` batch: allow `itemBrief` create/update/delete (same rules as `PUT`).
- MCP: `gtd_set_brief { itemId, brief, account }` and a `brief` field on `gtd_get_item` /
  `gtd_list_items` output; `SERVER_INSTRUCTIONS` gains one sentence: "A brief is a one-sentence,
  review-oriented condensation of title + notes — what the commitment is and why it is still open;
  never logistics." Copied to `mcp-server/` (parity test).
- `docs/PUBLIC_API.md`: endpoint + field docs.

Tests: `v1ItemBrief.test.ts` (PUT create/update/delete, origin by auth kind, 404 non-owned,
projection shape, filter), MCP parity, `mcpEndpoint.test.ts` tool listing.

## 1.3 Client entity + editor section + review presentation

- `types/MyDB.ts`: `StoredItemBrief`, `itemBriefs` store (IDB version bump; upgrade handler adds the
  store — follow the v7→v8 `blocked/blocking` pattern so stale tabs cannot deadlock).
- `db/syncHelpers.ts`: `case 'itemBrief'` arm, `EntityStoreName`, bootstrap apply.
- `db/itemBriefMutations.ts`: `setBrief(db, item, text)` → upserts with `origin: 'user'`,
  `sourceHash` from the item's current title/notes, queues the op; `clearBrief`.
- `lib/briefSource.ts`: mirror of the server module (hash + state) with a parity fixture test.
- `lib/briefPreference.ts`: `useShowBriefs()` / `setShowBriefs()` (localStorage).
- `itemEditor/BriefSection.tsx`: single-line text field under the title, placeholder "Brief (one
  line, for the weekly review)", pinned/stale marker, clear button. Joins `ItemFormSeeds` in
  `itemEditorLiveMerge.ts` and `useItemEditor.tsx` autosave (brief saves as its own op).
- **Review mode** (`ItemEditorBody` prop `presentation: 'edit' | 'review'`, set by `ClarifyStage`
  / `FocusStage`): when `showBriefs` is on and state ≠ `none`, the card renders title → brief
  line → structured chips, and `NotesSection` collapses to a "Show notes" disclosure. When state
  is `none`, current behaviour (capped notes preview) is unchanged.
- Toggle "Show briefs" in the Weekly Review sticky header and in Settings.
- Storybook stories for `BriefSection` and the review card in both states.

Tests: unit — `briefSource` parity, `itemBriefMutations` (op shape, hash stamped from current
item), `syncHelpers` arm (delete the arm → typecheck fails, per reviewer memory), live-merge with a
clean vs dirty brief field, preference hook. e2e — `item-brief-authored.spec.ts`: type a brief in
the editor, reload, brief persists and syncs to a second context; `weekly-review-brief.spec.ts`:
card shows brief first with notes collapsed, toggle off restores the notes preview, editing notes
flips a model-origin brief to `none` (seeded via `gtd_set_brief`-equivalent API call with
`origin: 'model'` test hook) and keeps a user-origin brief with the stale marker.

---

# Phase 2 — generation core, on-demand button, MCP generate, write-path escape hatch

## 2.1 Generation core (`lib/brief/`)

- `briefPrompt.ts`: `buildBriefRequest(item): MessageCreateParams` — cached system block, user
  turn `<title>…</title><notes>…</notes>`, structured-output schema `{ brief: string | null }`.
  Prompt asks for the review decision ("what this is and why it is still open"), one sentence,
  a soft 160-char target, notes' language, `null` when the title already says it all, no invented
  facts. Multi-thread notes must be condensed into the shape of the whole (how many threads, who
  blocks most of them, what the user owns) — never a partial list trailing off in "and …".

  **Why the prompt carries a BAD/GOOD example pair (eval evidence, 2026-09-21).** A real user brief
  came back as `"… tickets assigned to Yosef and Nir, ongoing latency stats tracking, and…"` — an
  enumeration amputated by the then-160-char server truncation. Removing the truncation alone was
  **not** enough: sampling the live Haiku prompt 3× on that item's notes, the model still walked the
  numbered list and simply had room to finish it (242–271 chars). Adding the explicit BAD/GOOD pair
  flipped it to a real abstraction, and a "never name more than two people/tickets — count them
  instead" rule tightened it further. Final 8-run sample on that item: **8/8** ended in a complete
  sentence with no ellipsis, **8/8** opened with the shape ("Six open threads…, most blocked on
  teammates"), lengths 93–183 chars. Best output: `"Six open latency threads, most blocked on
  teammates; only the recurring stats check is yours."` (93 chars).

  **Known residual:** roughly half the runs still append a partial breakdown after the shape
  sentence — wordier than ideal, but no longer a list that trails off. That variance is inherent to
  a one-shot Haiku call; the deterministic guarantees (no truncation, no ellipsis) live in
  `fitBriefText`, not the prompt. Keep the BAD/GOOD example pair and the cardinality rule when
  reworking this prompt — the abstract rules alone lose to the model's instinct to be complete.
  Unit tests pin that the rules are *present*, not that the model obeys them; re-run a sample like
  the above after a prompt change.
- `briefModel.ts`: `BRIEF_MODEL`, `generateBriefText(item)` → parses the JSON text block; maps SDK
  errors through `lib/claude/agentError.ts` (`503 agent_unavailable` when no key, `429` passthrough).
  `BRIEF_FAKE_MODEL=1` short-circuits to the deterministic fake (e2e only; refused in production
  by `config.ts`).
- `briefWriter.ts`: `writeModelBrief(userId, itemId, sourceHash, text, deviceId)` — re-reads the
  item, **discards** if `hash(item) ≠ sourceHash` (content moved on; next sweep requeues), refuses
  to overwrite a pinned brief unless `force`, then `applyAndPublishOperation` create/update.
  `writeSkippedBrief(...)` for the skip rule.
- `briefTargets.ts`: `isBriefTarget(item, brief)` + `findBriefTargets(limit)` (shared by Phase 3).

Tests: `briefPrompt.test.ts` (snapshot of request shape, cache_control present, notes with
instruction-like text stay inside the data block), `briefWriter.test.ts` (CAS discard, pinned
refusal, force override, op stamps `server:brief`), `briefModel.test.ts` with `vi.mock` on
`anthropicClient.js` (null brief, malformed JSON → error, refusal stop reason → error).

## 2.2 On-demand endpoint + client button + MCP

- `POST /v1/items/:id/brief/generate` (dual auth like `/v1/claude/assist`; scope `items.write`),
  body `{ force?: boolean }`. Runs `generateBriefText` inline, writes via `briefWriter`, returns
  the brief. Per-user cap: 30 generations / 10 min (`lib/rateLimiter.ts` bucket, env-tunable) so a
  stuck button cannot burn the key.
- Client `api/briefApi.ts` + `BriefSection` "Generate" icon button (sparkle): spinner, applies the
  returned snapshot locally through the same LWW helper the pull path uses (idempotent with the SSE
  op that follows), toast on error, disabled offline with tooltip. Present in both `edit` and
  `review` presentation, so the review card has the button too. "Regenerate" (same button) when a
  pinned brief exists asks for confirmation inline ("Replace your brief?").
- MCP `gtd_generate_brief { itemId, force?, account }`.
- `docs/PUBLIC_API.md` + MCP instructions.

Tests: `v1ItemBriefGenerate.test.ts` (scope gate, ownership, rate-limit, force semantics, fake
model on/off), client `briefApi.test.ts`, e2e `item-brief-generate.spec.ts` with `BRIEF_FAKE_MODEL=1`
(button → brief appears; a second context receives it by sync; regenerate over a user brief asks
first). The unit suite, not e2e, covers real-SDK behaviour.

## 2.3 Write-path escape hatch (flag, off by default)

- `lib/brief/briefInlineHook.ts`: `scheduleInlineBrief(userId, itemId)` — trailing debounce
  30 s per item (module-level timer map + `KeyedMutex`, correct under `--max-instances=1`), then
  `isBriefTarget` → `generateBriefText` → `briefWriter`. Fire-and-forget with `.catch` logging;
  never blocks the write response.
- Hooked in `applyOperation.ts` after a successful `item` create/update when
  `process.env.BRIEF_INLINE_ON_WRITE === '1'`. Skips ops stamped `server:*` and calendar-inbound
  writes (GCal churn must not trigger model calls — see the perpetual-noop memory).
- Documented in `docs/gcp-deploy-plan.md` as an operator switch; not set in either environment.

Tests: debounce coalesces N writes into one call (fake timers), flag off → zero calls, server-stamped
ops skipped, generation failure logged and swallowed.

---

# Phase 3 — Message Batches sweep + Cloud Scheduler + backfill

> Implemented 2026-09-21 on `feat/item-brief` (server side; the wizard trigger is a client
> follow-up). Deviations from the original draft are marked **(as built)**.

## 3.1 Batch pipeline

- Collections `briefBatches` `{ _id: batchId, createdTs, submittedCount, status:
  'processing' | 'harvested' | 'expired' | 'failed', harvestedTs?, resultCounts? }` and
  **(as built)** `briefBatchRequests` `{ _id: customId, batchId, user, itemId, sourceHash }` +
  DAOs. Anthropic caps `custom_id` at 64 chars of `[A-Za-z0-9_-]`; a Better Auth user id (32) +
  item UUID (36) + hash (≤ 11) is 81 chars and the `:` separator is not even allowed, so the
  identity lives in a request row keyed by an opaque 32-hex `custom_id`. Rows are deleted once
  their batch is harvested/expired/failed.
- `briefBatch.ts`:
  - `submitBriefBatch({ limit })`: `findBriefTargets(limit)` → `planFromTarget` per target →
    skip plans are executed immediately through `executeBriefPlan` (row written, no request;
    deviceId `server:brief-batch`) → model plans become batch requests with
    `params = buildBriefRequest(item)` (byte-identical to the on-demand path, so the cached
    system prefix serves both) → `client.messages.batches.create` → request rows → batch row
    (written LAST so a `processing` row always has its requests). Returns
    `{ submitted, skipped, inFlight, batchId? }`. Submits nothing while a batch is `processing`.
    Under `BRIEF_FAKE_MODEL=1` the model plans run through the direct fake generator, the SDK
    is never touched and the in-flight guard is bypassed — the e2e/dev seam.
  - `harvestBriefBatches()`: for each `processing` row `batches.retrieve`; if `ended`, stream
    `batches.results`, key by `custom_id` (results arrive in any order), and for each
    `succeeded` parse the message with the shared `parseBriefResponse` (`briefModel.ts`) and
    `writeModelBrief` (CAS discards stale, pinned rows untouched); `errored` with
    `invalid_request_error` is logged loudly, other `errored` / `canceled` / `expired` are only
    tallied — the target stays stale and the next sweep resubmits it. Marks the row `harvested`
    with `resultCounts { succeeded, errored, canceled, expired, discardedStale, pinned, written }`.
    Still `processing` after 26 h → `expired`; unknown to Anthropic (404) → `failed`; transient
    errors leave the row for the next sweep.
- `briefSweep.ts`: `runBriefSweep({ limit })` = harvest then submit, serialized on a single
  `KeyedMutex` key (an overlapping cron hit waits, then finds the batch in flight).
- `briefSweepMine.ts` (open decision 5, "keep, but only run on those that have their
  title+notes checksum different"): `startReviewBriefSweep(userId)` selects ONLY the caller's
  LIVE items (`inbox`, `nextAction`, `calendar`, `waitingFor`, `somedayMaybe`) satisfying
  `isBriefTarget` (no row, or hash mismatch on a `model` / `skipped` row — never pinned); writes
  skip rows for every short-notes one synchronously (cheap, unbounded); runs at most
  `BRIEF_REVIEW_SWEEP_MAX = 50` model generations in the background, strictly one at a time
  through the shared drain (`briefDrain.ts`, also used by the inline hook), deviceId
  `server:brief-sweep-mine`. Does not charge the on-demand cap; limited to once per user per
  `BRIEF_REVIEW_SWEEP_COOLDOWN_MS` (10 min) — inside the cooldown it returns
  `{ started: 0, cooldown: true }`, otherwise `{ started, skippedWritten, cooldown: false }`.
- `POST /maintenance/briefs/sweep`: cron-secret guarded (`requireCronSecret`), NOT
  session-authed; body `{ limit? }` clamped to [1, 2000]; returns `{ harvest, submit }`.
  `POST /maintenance/briefs/sweep-mine`: session-authed, no body; returns the
  `startReviewBriefSweep` result. Both documented in `docs/gcp-deploy-plan.md` (ops surface,
  not `PUBLIC_API.md`).
- `WeeklyReviewWizard` calls `sweep-mine` once per review start (fire-and-forget, offline-safe)
  — **client follow-up, not in this phase**.

Tests: `briefBatch.test.ts` (custom_id contract + round-trip, skip rows never submitted,
in-flight guard, params equal `buildBriefRequest`, harvest routing per `result.type` in shuffled
order, CAS discard, pinned untouched, done/trash NEVER briefed + revive re-targets, 26 h expiry, 404 → failed vs
transient, unusable payloads, fake seam), `briefSweep.test.ts` (order, serialization, failure
isolation), `briefSweepMine.test.ts` (live statuses, pinned/fresh/other-user exclusion, 50-cap
with unbounded skips, serial background execution, failure isolation, cooldown, cap
independence), `maintenanceBriefs.test.ts` (401/200, limit clamp, session scoping),
`cronSecret.test.ts`.

## 3.2 Scheduler + rollout

- Cron secret **renamed** `CALENDAR_WEBHOOK_CRON_SECRET` → `CRON_SECRET`, header
  `x-webhook-cron-secret` → `x-cron-secret`, shared `requireCronSecret` middleware used by the
  renewal route and the sweep route. Operator checklist in `docs/gcp-deploy-plan.md`
  § "Operator steps for the rename" (create the new GitHub secret with the same value in both
  environments, switch the renewal job's header, redeploy, then create the sweep job; rotate
  last).
- `docs/gcp-deploy-plan.md` § "Brief sweep (Cloud Scheduler)": job `gtd-<env>-brief-sweep`,
  `*/15 * * * *`, `gcloud` commands for staging and production.
- Staging first: run the sweep by hand (`gcloud scheduler jobs run`), watch `briefBatches`,
  confirm briefs land on the staging client, check Anthropic Console spend, then create the
  production job.
- Backfill is just the first few sweeps (2 000 targets each); no separate script.

## 3.3 Cost (for the record)

| Model | Per brief (batch) | Per brief (inline) | 5 000-item backfill |
|---|---|---|---|
| `claude-opus-5` | ≈ $0.0025 | ≈ $0.005 | ≈ $12 |
| `claude-haiku-4-5` | ≈ $0.0005 | ≈ $0.001 | ≈ $2.50 |

Assumes ~400 input tokens per item, ~40 output tokens, and the skip rule removing most
short-note items. Steady state is a few cents a week. **Note:** the original estimate assumed a
cached system prompt; it is not cached on Haiku 4.5 (below the 4096-token floor), so each brief
pays ~642 system tokens at full input rate. At Haiku's $1/MTok that is ~$0.0006 per brief — small
in absolute terms, but it means prompt length is a real per-call cost, not a one-off.

---

## Test matrix summary

| Layer | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| API unit | entity sync, LWW, cascades, PUT/GET/filter, MCP parity | prompt, writer CAS, model mock, generate route, inline hook | batch submit/harvest, sweep + sweep-mine, cron secret, sweep routes |
| Client unit | hash parity, mutations, sync arm, live-merge, preference | briefApi, button states | wizard sweep trigger |
| e2e | authored brief + review presentation + toggle | generate button (fake model) + regenerate confirm | none (no Anthropic in CI); staging manual run |

## Open decisions (please answer inline)

1. **Model**: `claude-opus-5` (reference default) or `claude-haiku-4-5` (5× cheaper, plenty for a
   one-liner)?
   Haiku
   > Resolved 2026-09-20: `BRIEF_MODEL = 'claude-haiku-4-5'` (`lib/brief/briefPrompt.ts`), switched before any
   > `origin: 'model'` row existed, so the corpus is single-model.
2. **Pinned-but-stale display**: show the user/agent brief with a marker (proposed) or hide it like
   a model brief?
   show the user/agent brief with a marker
3. **Skip threshold** 160 chars of notes — fine, or lower (e.g. 80) so more items get a brief?
   160 ok for now
4. **Default for "Show briefs"** on (proposed) or off?
default on
5. **`sweep-mine` on review start**: keep (fresh briefs, ≤ 50 direct calls per review) or drop and
   rely purely on the 15-min batch cadence?
   keep, but only run on those that have their title+notes checksum different.
   > Resolved 2026-09-21: `lib/brief/briefSweepMine.ts` — selection is `isBriefTarget` over the
   > caller's live items only (no row, or checksum mismatch on a model/skipped row); ≤ 50 model
   > calls per run, serial, background; once per user per 10 min. Server side shipped; the
   > wizard call is a client follow-up.
6. **Cron secret reuse** (`CALENDAR_WEBHOOK_CRON_SECRET`) vs a dedicated `BRIEF_CRON_SECRET`?
Reuse, but rename it to CRON_SECRET
   > Resolved 2026-09-21: renamed everywhere to `CRON_SECRET` / header `x-cron-secret`, shared
   > `auth/cronSecret.ts` `requireCronSecret` on both the renewal and the sweep routes. Operator
   > rename checklist in `docs/gcp-deploy-plan.md`.
7. **Origin for MCP writes**: `agent` (proposed, pinned like `user`) — or should agent-written
   briefs be regenerable by the sweeper (`model` semantics)?
   pinned
