# Case F5 — App delete instance + GCal concurrent modify of same instance

**Read first:** shared preamble. **Matrix:** F5. Timing-dependent; flake risk.

## Setup
Fresh weekly-Mon routine `e2e-smoke-F5-<ts>`. Wait ≤30s. Pick next future Monday.

## When
Rapidly (<2s):
1. App: trash that Monday instance.
2. GCal: edit same Monday's time 09:00 → 12:00, save "This event only".

## Then
Wait ≤30s. Observe:
- App Calendar: is that Monday present or gone?
- GCal: is that Monday present with 12:00 override or gone?
- Matrix states deletion should take precedence.

## Record
Append result block. Record which side "won" the conflict.
