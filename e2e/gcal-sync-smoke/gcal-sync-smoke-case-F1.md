# Case F1 — Same instance edited in app and GCal between syncs

**Read first:** shared preamble. **Matrix:** F1. Timing-dependent; flake risk.

## Setup
Fresh weekly-Mon routine `e2e-smoke-F1-<ts>`. Wait ≤30s for GCal sync. Pick next future Monday.

## When
Execute rapidly (<2 seconds):
1. In app, edit that Monday's time 09:00 → 10:00. Save.
2. Immediately switch to GCal tab, edit same Monday occurrence 09:00 → 11:00 (you may see stale 09:00 from before your app edit — that's fine), save "This event only".

## Then
Wait ≤30s. Record observed final state:
- App: what time?
- GCal: what time?
- Last-write-wins should resolve to whichever had later `updated` timestamp. Typically GCal will win because its edit was ~1s later.

## Record
Append result block. Note flake risk: this depends on which side completed mutation last in wall-clock time.
