# Calendar ↔ Routine Sync Smoke Test — Plan Index

All plans live in this folder (`e2e/gcal-sync-smoke/`). Each runs in a **fresh Claude session** so context never exceeds budget.

## How to run a plan

**Only run these plans against the GTD test user `yuval.gtd.test@gmail.com`.** Never run them against any other Google account.

Open a fresh Claude session in `/Users/yuvalyssak/gtd-e2e-ai-driven` and paste:

> Execute the plan at `e2e/gcal-sync-smoke/<filename>`. Follow the shared preamble. Use the GTD test Google account `yuval.gtd.test@gmail.com` at `/u/2/`.

## Shared preamble (read first — all cases depend on this)

- `gcal-sync-smoke-case-shared-preamble.md`

## Per-case plans

### Session 1 — Basics + Conflicts

#### A. App-originated routine, then app-side change
- `gcal-sync-smoke-case-A1.md` — Create calendar routine in app, link to GCal
- `gcal-sync-smoke-case-A2.md` — Modify instance time in app
- `gcal-sync-smoke-case-A3.md` — Modify instance title/notes in app
- `gcal-sync-smoke-case-A4.md` — Trash instance in app
- `gcal-sync-smoke-case-A5.md` — Edit master title/notes in app
- `gcal-sync-smoke-case-A6.md` — Change routine RRULE in app
- `gcal-sync-smoke-case-A7.md` — Delete routine in app
- `gcal-sync-smoke-case-A8.md` — Complete instance in app
- `gcal-sync-smoke-case-A9.md` — Offline edit then reconnect

A1 is the foundational case — run it first in any new session. The known DTSTART anchor bug (GCal renders an extra creation-day occurrence on non-BYDAY weekdays) is expected; mark as `Pass-with-anomaly`.

#### B. App-originated routine, then GCal-side change
- `gcal-sync-smoke-case-B1.md` — Modify instance time in GCal
- `gcal-sync-smoke-case-B2.md` — Modify instance title/description in GCal
- `gcal-sync-smoke-case-B3.md` — Delete instance in GCal
- `gcal-sync-smoke-case-B4.md` — Edit master title/description in GCal
- `gcal-sync-smoke-case-B5.md` — Change master RRULE in GCal
- `gcal-sync-smoke-case-B6.md` — Change master time of day in GCal
- `gcal-sync-smoke-case-B7.md` — Change master duration in GCal
- `gcal-sync-smoke-case-B8.md` — Delete master event in GCal

#### C. GCal-originated routine, then app-side change
- `gcal-sync-smoke-case-C1.md` — Import existing GCal recurring event as routine
- `gcal-sync-smoke-case-C2.md` — Modify instance in app (GCal-originated)
- `gcal-sync-smoke-case-C3.md` — Trash instance in app (GCal-originated; semantically like A4 minus origin)
- `gcal-sync-smoke-case-C4.md` — Delete routine in app (GCal-originated)
- `gcal-sync-smoke-case-C5.md` — Edit master in app (GCal-originated)

#### D. GCal-originated routine, then GCal-side change
- `gcal-sync-smoke-case-D1.md` — Modify instance in GCal (GCal-originated)
- `gcal-sync-smoke-case-D2.md` — Delete master in GCal (GCal-originated)
- `gcal-sync-smoke-case-D3.md` — Move event between calendars (expected N-A)

#### F. Concurrent edits / conflict resolution
- `gcal-sync-smoke-case-F1.md` — Same instance edited both sides
- `gcal-sync-smoke-case-F2.md` — Master notes edited both sides
- `gcal-sync-smoke-case-F3.md` — Echo suppression (immediate webhook)
- `gcal-sync-smoke-case-F4.md` — Echo window expired (slow webhook)
- `gcal-sync-smoke-case-F5.md` — App delete instance + GCal modify same instance
- `gcal-sync-smoke-case-F6.md` — App master delete + GCal concurrent instance edit

### Session 2 — Splits, Timezones, UNTIL, Deactivation (not per-case yet)

Session 2 still lives as a single composite plan. If it runs long, split per-case using the same template as Session 1.

- `gcal-sync-smoke-session-2-splits-tz-until-deactivation.md`
  - E-series: "This and following" splits (E1–E8)
  - G-series: Timezone changes (G1–G4; G3 N-A)
  - H-series: UNTIL boundary / series end (H1–H7; H1/H2 N-A)
  - I-series: Routine deactivation (I1–I6)

#### I. App-side pause / resume (per-case)
- `gcal-sync-smoke-case-I7.md` — App-side pause (GCal master capped with UNTIL, not deleted)
- `gcal-sync-smoke-case-I8.md` — App-side resume via new startDate (UNTIL cleared, items regenerate)

#### K. startDate edits (per-case)
> Labeled K here (not J) because `CALENDAR_ROUTINE_SYNC_TESTS.md` already uses J for webhook/sync-token expiry cases.
- `gcal-sync-smoke-case-K1.md` — Create calendar routine with future startDate
- `gcal-sync-smoke-case-K2.md` — Edit startDate forward on routine with `done` past items (split)
- `gcal-sync-smoke-case-K3.md` — Edit startDate forward on routine without `done` past items (in-place)
- `gcal-sync-smoke-case-K4.md` — Edit startDate backward
- `gcal-sync-smoke-case-K5.md` — Edit startDate past UNTIL (no-op + log)

## Results file

All per-case sessions append a result block to:

- `session-1-results.md` (in this folder; git-ignored)

Each block starts with a **Run at:** line (ISO 8601 timestamp from `date -Iseconds`, captured at case start) so re-runs stay ordered and the elapsed time between runs is visible at a glance. See the shared preamble step 7 for the full entry template.

Currently contains A1 (Pass-with-anomaly) and A2 (N-A — superseded now that full editing ships).

## Original umbrella plans (reference only)

These are the pre-split composite plans. Not for execution anymore, but kept as source-of-truth for the test matrix context:

- `gcal-sync-smoke-session-1-basics.md` (superseded by per-case plans)
- `gcal-sync-smoke-session-2-splits-tz-until-deactivation.md` (still active for Session 2)

Full matrix reference: `docs/CALENDAR_ROUTINE_SYNC_TESTS.md` (repo root).

## Recommended next action

Re-run **A2** first — the "per-instance time edit" path that was N-A at time of the original run is now implemented (unified editor + `updateRecurringInstance` server push). Then proceed with A3 → A9, then B-series, etc.
