---
name: instance-id-unique-index-not-status-scoped
description: The (user, calendarInstanceEventId) unique index is NOT status-scoped, but tier-1 resolve IS — so any new write that sets calendarInstanceEventId can E11000 against a trash/done dead twin
metadata:
  type: project
---

`itemsDAO` builds `{ user: 1, calendarInstanceEventId: 1 }` unique with
`partialFilterExpression: { calendarInstanceEventId: { $type: 'string' } }` — **no status filter**.
But `resolveExceptionTarget`'s tier-1 lookup scopes to `status: 'calendar'`. The asymmetry means a
`trash`/`done` dead twin can hold an instance id that tier 1 will never find, so any code path that
*writes* that id (backfill, revive re-key, orphan insert) collides with an invisible squatter.

This is common, not racy. `handleOrphanInsertDuplicate` / `isDemotableDeadTwin` exist precisely
because dead-twin squats happen routinely (pause-resume, disconnect-reconnect, split successor).

**Why:** a tier-3 review found an E11000 try/catch wrapped around the *whole* conditional update
instead of just the backfill field. Its docstring claimed the collision was "only reachable" via a
concurrent orphan-create race; in fact a plain dead twin triggered it, and the absorb silently
dropped the entire inbound time move — permanently, on every subsequent sync. Pre-fix behaviour was
a recoverable duplicate row; the "fix" turned it into unrecoverable data loss.

**How to apply:** when a diff adds a write of `calendarInstanceEventId` or an `isDuplicateKeyError`
absorb near one, (a) demand the catch scope be the *narrowest* thing that can collide — retry
without the id rather than abandoning the whole `$set`; (b) reject docstrings asserting the
collision is race-only; (c) require a fixture with a `done`/`trash` row on a **foreign** routine
holding the same id. Cross-link [[e11000-reresolve-status-unfiltered-finder]] and
[[heal-revive-ignores-sibling-active-unique-index]] — same family of index-vs-finder predicate drift.

**Resolved shape (2026-08-15, `updateItemRetryingWithoutBackfill`)** — the accepted pattern is:
try the update with the backfill; on E11000 **and** only when this update actually carried a
backfilled id, strip that one key and re-run the same conditional update. Non-backfill E11000
rethrows rather than being swallowed. The move lands; only id adoption waits for the squat to clear.
Use this as the reference when reviewing the next "absorb E11000 around a broader write" diff.
