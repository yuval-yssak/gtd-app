---
name: broadened-finder-must-bound-cardinality
description: When a fix widens a resolver to close a "missed the row" gap, demand a cardinality guard — the delete/trash branch usually writes by filter and will claim every extra match
metadata:
  type: feedback
---

A resolver widened to fix a *miss* (duplicate created because nothing matched) must bound how many
rows it can now claim. In this codebase the resolved target is a `{ filter, matches }` pair, and the
`deleted` branch writes through `filter` via `updateItemsAndRecordOps` with **no cardinality guard**
— so one cancelled occurrence trashes N rows, and ops are recorded for all of them, propagating the
wrong delete to every device.

Severity direction matters: the pre-fix failure was a duplicate row (visible, recoverable); the
post-fix failure was a silently trashed live item (invisible, unrecoverable). A "fix" that trades a
duplicate for a delete is a regression even though it closes the reported bug.

**Why:** a tier-3 instant-keyed lookup returned *every* legacy row of the routine sitting at a
candidate instant. Two occurrences dragged onto the same time is ordinary user behaviour, not an
exotic race. Reproduced: one `deleted` exception trashed both rows; the `modified` path was
non-deterministic (both rows got the same `$set`, the backfill winner decided by `Promise.all`
interleaving plus who lost the E11000).

**How to apply:** for any widened finder, ask "what if this returns 2?" and check each consuming
branch separately — read/patch branches may tolerate it while delete/trash branches do not. Prefer
bailing out on ambiguity (`matches.length > 1` → decline the tier, log, fall through) over
best-effort claiming. Demand one test per branch with an ambiguous fixture. Pair with
[[verify-tests-discriminate-by-stashing-source]]: stash the source, confirm the pre-fix fixture
produced the *milder* failure, and make sure the new behaviour isn't worse.

**Resolved shape (2026-08-15, `resolveByMovedInstant`)** — `matches.length > 1` → warn and return an
empty-match / empty-`$in` target, i.e. treat ambiguity as a miss so the caller degrades to exactly
the pre-fix behaviour. State that degradation target explicitly in the docstring ("worst case is a
recoverable duplicate, never data loss"); it is what makes the guard reviewable. Verified the guard
discriminates by flipping the condition to `if (false)` and watching the ambiguous-`deleted` test
flip to `['trash','trash']`.
