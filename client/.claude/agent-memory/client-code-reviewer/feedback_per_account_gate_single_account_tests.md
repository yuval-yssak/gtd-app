---
name: per-account-gate-single-account-tests
description: Gates keyed on "did THIS account's pass sync" (onUserSynced set membership) ship with single-account tests only, which cannot tell has(activeId) from size>0.
metadata:
  type: feedback
---

Wrappers around syncAllLoggedInUsers that gate a follow-up (seeding, refresh) on the active account's own pass outcome tend to be tested with one seeded account only. Mutating `synced.has(activeUserId)` to `synced.size > 0` (or "any pass succeeded") leaves the suite green.

**Why:** the whole point of such a gate is multi-account isolation (active skipped while another account synced); a single-account fixture collapses both conditions. Seen on syncThenSeedRoutines (2026-10-30).

**How to apply:** demand a two-account test with the active account's pass failing (401 / missing session) and the other succeeding, asserting no follow-up; mentally mutate the predicate before approving. Related: [[wasactive-read-inside-session-pivot]], [[concurrency-fix-untested-layer]].
