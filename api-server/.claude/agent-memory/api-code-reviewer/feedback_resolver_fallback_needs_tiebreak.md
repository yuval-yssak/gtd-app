---
name: resolver-fallback-needs-tiebreak
description: Any "most recent row wins" resolver over a multi-row collection needs a secondary sort key, or the winner flaps with Mongo's unordered find() order between identical-timestamp rows
metadata:
  type: feedback
---

When reviewing a resolver that picks one value out of N rows by sorting on a timestamp
(`resolveUserTimezone` sorting `deviceSyncState` by `timezoneReportedTs` is the canonical case),
require a **secondary sort key** — usually `_id`.

**Why:** ISO-millisecond timestamps collide in practice. Two devices pulling in parallel (SSE
wakes both on the same change) land in the same millisecond routinely. `Array.prototype.sort` is
stable, so with only the primary key the winner is decided by the order Mongo's unordered
`find()` happened to return — which can differ between two calls in the same request path. The
symptom is not a wrong value but a *flapping* one, which is far harder to diagnose: the same
user gets Kiritimati on one generation event and Pago Pago on the next.

**How to apply:** grep the sort comparator for a `||` fallback. If there isn't one, ask for it.
The paired test must seed two rows sharing the exact timestamp and assert the SAME winner twice
in a row — a single assertion can pass by luck. Verify the test discriminates by deleting the
secondary comparator and confirming failure (it does fail: natural insertion order returns the
first-inserted row).

Same family as [[project_sync_same_ms_boundary_drop]] — same-millisecond ties are a recurring
source of bugs in this codebase, on both cursors and resolvers.
