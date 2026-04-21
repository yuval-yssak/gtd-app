# Calendar ↔ Routine Sync Smoke Test — Session 2: Splits, Timezones, UNTIL, Deactivation

**Status:** ready to execute in a new session. Self-contained — read top to bottom and follow.
**Estimated runtime:** ~2-2.5 hours. ~350-550k tokens.
**Scope:** Sections E, G, H, I of `/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md` — 25 cases.
**Prerequisite:** Session 1 (`gcal-sync-smoke-session-1-basics.md`) should have run first. If it revealed load-bearing failures, fix those before running Session 2 — the cases here depend on basic bidirectional sync working.

---

## What you are doing

The second half of a two-part observational smoke test. Session 1 established that basic app↔GCal sync works in both directions (sections A, B, C, D, F). This session exercises the harder semantics:
- **E** — "this and following" splits, which coordinate three mutations (cap original RRULE, create tail routine, propagate both to GCal)
- **G** — timezone edges (calendar TZ change, DST, user TZ ≠ calendar TZ)
- **H** — UNTIL boundary and COUNT limit semantics
- **I** — routine deactivation via GCal master deletion, including split-chain variants

Same rules as Session 1: **no code changes, no mocks, observational only**.

## Project context (brief)

- Working directory: `/Users/yuvalyssak/gtd-e2e-ai-driven` (NOT `/Users/yuvalyssak/gtd`).
- Full test matrix reference: `/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.
- Project guide: `/Users/yuvalyssak/gtd-e2e-ai-driven/CLAUDE.md`.
- Stack: React client :4173, Hono API :4000, IndexedDB + MongoDB, Better Auth, GCal integration via `CalendarIntegration` + `CalendarSyncConfig`.

## Preflight — do these before any scenario (blocking)

1. **Confirm client on :4173** (curl; connection-refused means ask user to start).
2. **Confirm API on :4000** (curl; 404 on `/` is fine).
3. **Load Chrome MCP tools:** `ToolSearch({ query: "claude-in-chrome", max_results: 30 })`.
4. **Open tabs** via `tabs_context_mcp` then `tabs_create_mcp` for the app and `https://calendar.google.com`.
5. **Verify login + GCal integration connected.**
6. **Ask the user for the dedicated test calendar name/ID.** Same calendar should be used as in Session 1 if possible.
7. **Check Session 1 report status.** Ask the user: did Session 1 reveal any load-bearing failures that block these cases? If so, flag and pause.

## Ground rules (same as Session 1)

- **Automatic sync only.** 30s cap. No "Sync now".
- **UI-only assertions.** No IndexedDB reads. Non-UI-visible fields marked `not checked (not UI-visible)`.
- **Unique titles:** `e2e-smoke-<case>-<unix-ts>`.
- **No cleanup.** Report, don't delete. Cases that delete as part of the scenario (I-series) do so because the scenario requires it.
- **Stop and ask triggers:** tool fails 2-3x, browser unresponsive, UI affordance unclear, sync >30s systemically.
- **Link safety:** no computer-use link clicks.

## Cases requiring user clarification at point of execution

These need affordances/gestures that can't be inferred from the matrix. **Pause and ask the user when you reach them. Do not guess.**

### E-series splits (E1, E5, E6)
The matrix says the user "changes RRULE, choosing 'this and all following'". What's unclear:
- Does the routine-edit dialog show a scope chooser (like GCal's "this event / this and following / all events" modal)?
- Which field edits trigger the split (RRULE only? time-of-day too?)?
- Is the anchor date "today" or user-selectable?

**At E1:** open the routine-edit dialog in front of the user, describe what you see, ask them to walk you through the split gesture. Same resolution applies to E5 (splitting an already-split tail) and E6 (split with an existing override).

### G1 calendar timezone change
Requires opening Google Calendar settings and changing the **calendar's** primary timezone. This is a destructive change on the user's real account even on a test calendar. **Before executing G1, confirm with the user** that it's OK to modify the test calendar's timezone, and restore it at the end.

### Cases flagged N-A upfront
These cannot be verified in a real-time observational run. Record the expected matrix behavior and mark `N-A`:
- **G3 DST transition** — requires crossing a real DST boundary or clock-shifting the server
- **H1 natural UNTIL reached** — requires time to advance past the UNTIL date
- **H2 COUNT limit reached** — same
- **H6 UNTIL vs horizon intersection** — feasible only if UNTIL can be set within the 2-month horizon and items regenerated; attempt it, otherwise N-A

## Execution & reporting cadence

- Order: E1 → E8, G1 → G4, H1 → H7, I1 → I6.
- **Report in batches of 10 cases.**
- Between cases: ~3-5s settle. Between sections: brief pause.

## Scope — 25 cases

### E. "This and following" splits (8)
- E1 App-side split via RRULE change (**asks user to describe UI flow**)
- E2 GCal-side split (user edits "this and following" in GCal)
- E3 App split + GCal edit on tail
- E4 GCal split + app edit on tail
- E5 Repeated splits (split a tail again)
- E6 App split with existing override on the original
- E7 GCal split with different RRULE on tail
- E8 Detection ambiguity (new unrelated event near split boundary → false-positive risk per matrix)

**Setup dependencies in E:**
- E3/E4 build on E1/E2 (need a completed split chain)
- E5 builds on E1 (need an existing split to split again)
- E6 needs a routine with a prior override (create via A2-style setup first)

### G. Timezone changes (4)
- G1 Calendar TZ changed in GCal settings (**confirm destructive change with user first**)
- G2 Master event TZ changed
- G3 DST transition — **N-A** (record expected only)
- G4 User TZ ≠ calendar TZ (observational — set device TZ mismatch via Chrome DevTools if available, otherwise note current device TZ vs calendar TZ)

### H. UNTIL boundary / series end (7)
- H1 Natural UNTIL reached — **N-A**
- H2 COUNT limit reached — **N-A**
- H3 App adds UNTIL
- H4 GCal adds UNTIL
- H5 GCal removes/extends UNTIL
- H6 UNTIL vs horizon intersection — attempt if UNTIL can be set inside the 2-month horizon; else N-A
- H7 Per-instance override on last occurrence before UNTIL

### I. Routine deactivation via GCal master delete (6)
- I1 Basic deactivation (master deleted in GCal → `R.active=false`, future items trashed, past/done kept)
- I2 Deactivate then reactivate in app
- I3 Exception sync after deactivation (subsequent syncs should skip deactivated routines)
- I4 GCal user recreates event with same pattern → should be treated as new routine (no resurrection)
- I5 Split chain: delete original (capped) routine's master (should not affect tail)
- I6 Split chain: delete tail's master (should deactivate tail only, not original)

**Setup dependencies in I:**
- I2 requires an I1-deactivated routine
- I3 requires an I1-deactivated routine and subsequent sync
- I5/I6 require a split chain from E1 or E2

## Per-case procedure

1. **Read the matrix entry** for exact Given/When/Then.
2. **Set up** (fresh routine or reuse a setup-chain routine). Title: `e2e-smoke-<case>-<ts>`.
3. **Perform the "When"** — for E/G1/destructive cases, confirm with user first.
4. **Wait ≤30s** for automatic sync.
5. **Verify "Then"** via UI only. Non-UI-visible fields → `not checked (not UI-visible)`.
6. **Record** as `Pass / Fail / N-A / Timeout`.
7. **Move on.** No retries. No "Sync now".

## Pre-execution questions for the user

Before case E1:
1. Confirm both `cd client && npm run dev` and `cd api-server && npm run dev` are running.
2. Which dedicated GCal test calendar? (Reuse from Session 1 if applicable.)
3. OK to modify the test calendar's timezone in G1, and restore it at the end?
4. Were there any blocking failures in Session 1 that should defer this run?

## Deliverable

A single markdown report with:

### Per-section result tables (E, G, H, I)
Columns: `#` · `Scenario` · `Expected (1-line summary)` · `Observed` · `Pass / Fail / N-A / Timeout` · `Notes`.

### Top issues summary
5-10 bullets grouped into:
- **Load-bearing failures** (break split semantics, deactivation, or TZ handling)
- **Likely flakes** (especially E2 — detection timing; G1 — TZ propagation)
- **Design-decision gaps** — cross-reference these matrix open questions:
  - #5 split detection heuristic false-positive risk (relevant to E8)
  - #6 wall-clock vs absolute time on TZ change (relevant to G1, G2)
  - #7 auto-deactivation on UNTIL (relevant to H1)
  - #8 link metadata after deactivation (relevant to I1)
- **Not-tested (N-A)** — G3, H1, H2 (and H6 if infeasible), with rationale

### Cleanup checklist
All test routines + GCal events created across Session 2, with:
- App-side title
- GCal event URL (if captured)
- End-of-run status (active / trashed / deactivated / series-deleted)
- User's delete path

**Do not delete anything.**

## Starting the session — suggested first message

> Execute the plan at `e2e/gcal-sync-smoke/gcal-sync-smoke-session-2-splits-tz-until-deactivation.md`. Start with the preflight checks.
