# Case F4 — Echo window expired (slow webhook delivery)

**Read first:** shared preamble. **Matrix:** F4. Timing-dependent.

## Setup
Fresh weekly-Mon routine `e2e-smoke-F4-<ts>`. Wait ≤30s.

## When
Edit master title in app to `F4 slow echo`. Save. Wait ≥10s before any further action (gives the webhook/sync enough time that `isOwnEcho` returns false).

## Then
Verify:
- App: title `F4 slow echo`. No duplicate / no revert / no extra items.
- GCal: master title `F4 slow echo`.

Defense-in-depth via `lastSyncedNotes` should make this indistinguishable from F3 for the user-facing UI — `Pass` if no anomalies.

## Record
Append result block.
