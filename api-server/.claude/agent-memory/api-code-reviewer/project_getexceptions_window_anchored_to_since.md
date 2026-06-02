---
name: getexceptions-window-anchored-to-since
description: GoogleCalendarProvider.getExceptions timeMin is max(since, now-30d), NOT a fixed now-30d; reconcile-on-absence logic that hardcodes now-30d over-reconciles and drops valid past exceptions.
metadata:
  type: project
---

`GoogleCalendarProvider.getExceptions` uses `timeMin = dayjs(since).isAfter(now-30d) ? since : (now-30d)` and `timeMax = now+1y` (GoogleCalendarProvider.ts ~712). `since` is `config.lastSyncedTs` (calendar.ts ~1380), so in steady-state the real lower bound is the device cursor, NOT `now-30d`.

**Why:** Any reconcile-on-absence logic (e.g. `reconcileRemovedExceptions`, which reverts/drops a local modified routine exception when GCal stops reporting that instance) must derive its eligibility window from the SAME `max(since, now-30d)` formula. Hardcoding `now-30d` makes the window wider than the provider actually queried, so exceptions dated in `[now-30d, since)` are absent merely because they predate the cursor — not because they returned to master time. Treating that absence as "removed" silently reverts a still-valid past time-move and deletes the exception = data loss.

**How to apply:** On any new "GCal didn't report X, so delete/revert local X" path under syncRoutineExceptions, demand the window be anchored to `since` (thread it through; `SyncContext` lacks it, only `RoutineSyncCtx` has `since`). Also require a test that sets a RECENT `config.lastSyncedTs` — the test helper `makeSyncConfig` omits `lastSyncedTs`, so every existing calendar test runs with epoch `since` where the provider floor collapses to `now-30d` and this class of bug is invisible. Date-string `>=` compares vs the provider's ISO-datetime timeMin also add a same-day inclusive margin; prefer under-reconciling. Related: [[project_gcal_perpetual_noop_routine_updates]].
