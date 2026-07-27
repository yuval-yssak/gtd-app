---
name: concurrency-fix-untested-layer
description: Multi-layer race fixes ship with only the outer/wiring layer tested; the inner atomicity layer that actually fixes the bug has zero coverage — mutation-test it before approving.
metadata:
  type: feedback
---

When a concurrency fix ships as "two independent layers" (e.g. a cross-context lock PLUS an
atomic single-transaction read-check-write), expect the **wiring layer to be tested and the
atomicity layer to be untested**. Verify by mutation test, not by reading the test names.

**Why:** Observed on the 2026-07-27 cross-context sync-apply hardening. The Web Locks wiring
had two dedicated tests that correctly failed when the wrapper was removed. But replacing the
single `db.transaction(...)` read-check-write with the pre-fix non-atomic separate-await shim
left all 45 syncHelpers tests green. The atomicity layer is explicitly documented as the
fallback for browsers without the outer primitive — and in the node test env the outer
primitive is *always* absent, so every existing test runs in fallback mode yet pins nothing
about it. The two layers' tests never meet.

**How to apply:** For any change claiming layered defence against a race:
1. Actually run the suite with the inner layer reverted to its pre-fix shape. If it stays
   green, that is a blocking test gap — the exact regression that caused the incident can be
   silently reintroduced.
2. Ask for a test pinning the *contract* rather than true interleaving (which fake-indexeddb
   and node cannot reproduce): e.g. spy that exactly one `readwrite` transaction is opened per
   op, scoped to the right store. Cheap, deterministic, and it fails on a revert.
3. Also check the guard's positive and absent cases, not just the negative one — owner-guard
   suites tend to test only "skipped when owner differs", never "proceeds when owner matches"
   or "row absent locally".

Related: [[feedback_passthrough_helper_untests_wiring]] — same shape, different layer (the
tested thing is not the load-bearing thing).
