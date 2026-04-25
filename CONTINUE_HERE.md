# Continue Here — Calendar ↔ Routine Sync Smoke Test (per-case)

Session 1 (Sections A-F minus E, which lives in Session 2) is split into **one plan per case** — each runs in a fresh Claude session so context never exceeds budget. Results accumulate into a single file.

## How to run a case

Open a fresh Claude session in `/Users/yuvalyssak/gtd-e2e-ai-driven` and paste:

> Execute the plan at `e2e/gcal-sync-smoke/gcal-sync-smoke-case-<ID>.md`. Follow the shared preamble it references first. Use the GTD test Google account at `/u/2/`.

Replace `<ID>` with the case you want: `A2`, `A3`, `B1`, `F5`, etc.

## Plans index

- **Shared preamble** (all cases read this first): `gcal-sync-smoke-case-shared-preamble.md`
- **A (9 cases):** A1 (done), A2, A3, A4, A5, A6, A7, A8, A9
- **B (8 cases):** B1, B2, B3, B4, B5, B6, B7, B8
- **C (5 cases):** C1, C2, C3, C4, C5
- **D (3 cases):** D1, D2, D3
- **F (6 cases):** F1, F2, F3, F4, F5, F6

File paths: `e2e/gcal-sync-smoke/gcal-sync-smoke-case-<ID>.md`.

## Results

All runs append to `e2e/gcal-sync-smoke/session-1-results.md` (git-ignored). A1 is already recorded there.

## Preflight (each fresh session does it once)

1. Confirm client on `:4173` and API on `:4000` (via curl). If down, ask user to start — don't start yourself.
2. Load Chrome MCP tools in one shot: `ToolSearch({ query: "claude-in-chrome", max_results: 30 })`.
3. Open app tab + `https://calendar.google.com/calendar/u/2/r?pli=1` (the `/u/2/` URL is mandatory — it's `yuval.gtd.test@gmail.com`, the account the app is connected to).
4. Screenshot app to confirm logged in (sidebar visible, not `/login`). Screenshot GCal to confirm "Yuval GTD Test" calendar is selected.

## Ground rules (all cases)

- **Automatic sync only, 30s cap.** Never click "Sync now".
- **UI-only assertions.** Non-UI-visible fields → `not checked (not UI-visible)`.
- **Unique titles:** `e2e-smoke-<case>-<unix-ts>`.
- **No cleanup by Claude.** User cleans up from the results file's list.
- **Stop and ask if** Chrome MCP tool fails 2-3x, browser freezes, UI affordance unclear, or systemic >30s sync delays.

## Session 2 (still unchanged)

E-series, G-series, H-series, I-series plans live at `e2e/gcal-sync-smoke/gcal-sync-smoke-session-2-splits-tz-until-deactivation.md`. Session 2 may also benefit from per-case splitting if Session 1 runs long; re-evaluate after Session 1 completes.

## Open questions carried over from matrix

- #1 routine-delete vs integration-delete → answered by A7/C4
- #2 `lastSyncedNotes` for exceptions → probed by B2
- #3 in-place update vs regenerate on RRULE change → probed by B5/B6
- #4 cross-calendar move → probed by D3 (expected N-A)

## A1 findings already recorded (summary)

- **Pass-with-anomaly:** routine created + series propagated to GCal ✓, but GCal master `DTSTART` = creation day (Tue Apr 21) not snapped to first BYDAY=MO match → GCal shows a spurious Tue occurrence. App-side items correctly on Mondays only.
- Recommendation: when creating the GCal master event for a BYDAY-bearing RRULE, snap `DTSTART` to the first matching BYDAY date on or after `createdTs`.
- Full detail in the results file.
