# Case F6 — App master delete + GCal concurrent instance edit

**Read first:** shared preamble. **Matrix:** F6. Timing-dependent.

## Setup
Fresh weekly-Mon routine `e2e-smoke-F6-<ts>`. Wait ≤30s.

## When
Rapidly (<2s):
1. App Routines: delete `e2e-smoke-F6-<ts>`.
2. GCal: open next future Monday, change time 09:00 → 14:00, save "This event only".

## Then
Wait ≤30s. Observe:
- App: routine gone / inactive, all items trashed.
- GCal: master series + occurrences deleted (app-side delete wins + propagates). The orphan GCal instance edit should not resurrect anything.

## Record
Append result block. Record final observable state.
