---
name: forward-only-guard-vs-server-holdback
description: A client-side forward-only cursor guard silently becomes a permanent stall when the server starts advertising a deliberately held-back (backwards) boundary; the stalled cursor also freezes the server-side purge floor.
metadata:
  type: feedback
---

A client guard shaped `if (incoming > stored) store(incoming)` is safe only while the server's
advertised value monotonically climbs. The moment the server starts advertising a *deliberately
lower* boundary (a holdback window, a clamped ceiling, a debounce floor), any cursor that gets
above that ceiling is refused forever — the guard cannot tell "stale response from a concurrent
call" apart from "the server means this".

**Why:** `/sync/pull` began capping its advertised `(serverTs, serverId)` at `now − 5s` so
late-committing ops are re-checked instead of skipped. `advanceSyncCursor`'s forward-only guard
then refuses every boundary for a device whose cursor sits above that window — e.g. a pre-change
bootstrap row stamped `(now, MAX_OP_ID)`, or clock skew. Pre-holdback this self-healed because the
advertised value was a real op `ts` that eventually overtook any stalled cursor; with a permanent
`now − 5s` ceiling it never does. The second-order damage is the expensive part: `doPull` passes
the same cursor as `ackedTs`, so a stranded cursor also freezes that device's purge floor, and the
floor is a `min` across devices — one stuck device stops op-log purging for the whole account.
This project has already hit op-log bloat write-blocking a staging M0 quota.

**How to apply:** When reviewing a monotonicity guard against a changed server contract, ask *what
the guard is actually defending against* and scope it to that. Here the real hazard is a concurrent
same-context pull advancing the cursor mid-flight — so compare the re-read cursor against the
**pre-fetch cursor**, not against the response boundary. That keeps the concurrency protection
(and its existing test, which advances the cursor inside the fetch mock) while letting the server's
intentional holdback through.

Generalize: any `forward-only` / `never-rewind` / `max(a,b)` guard on a value the server now
intentionally lowers is a stall bug. Trace whether the stalled value is *also* reported back to the
server (ack cursors, watermarks, floors) — that turns a local inefficiency into a server-side
resource leak with no UI signal.

Related: [[feedback-server-protocol-change-leaves-client-tests-lying]]
