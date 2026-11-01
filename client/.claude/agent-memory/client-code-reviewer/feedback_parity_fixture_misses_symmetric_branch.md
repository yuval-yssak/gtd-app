---
name: parity-fixture-misses-symmetric-branch
description: Client↔api-server parity fixture tables (port pinning) tend to cover only one of a pair of symmetric loops (hi-trim but never lo-trim), so drift in the other side passes both suites.
metadata:
  type: feedback
---

When a client function is ported to api-server and pinned by a shared fixture table, hand-trace every
fixture through the original: the itemMoveParity tables (2026-11-01) hit hi-edge trim in 5/6 rows but
never lo-edge trim, never lo-growth stopping above 0, never from > to or out-of-range `to`.

**Why:** the parity table is the only guard against the port drifting; an unexercised branch is unpinned.
**How to apply:** run the probe against the port with tsx from a scratchpad file to confirm the
suggested extra fixtures' expected values before proposing them. Related: [[revert-check-regression-tests]].
