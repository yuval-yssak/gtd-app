---
name: heal-revive-ignores-sibling-active-unique-index
description: Heal/revive endpoints that flip a routine to active:true must check for a sibling already-active routine on the same series, or they E11000 against uniq_active_routine_per_gcal_series at runtime + crash next boot.
metadata:
  type: project
---

`healStuckGCalRoutines` (lib/calendarHeal.ts) deduped the *stuck* set per series via `mostRecentPerSeries`, but that grouping spans ALL linked routines (active and inactive), and the boot dedupe (`dedupeActiveRoutinesPerGCalSeries`) legitimately leaves an active + one-or-more-inactive pair per series. When the most-recent row in a series is a stuck inactive one and an OLDER healthy active sibling exists, `reviveRoutine`'s plain `replaceById(... active:true)` produces TWO active rows on one series → E11000 against the live `uniq_active_routine_per_gcal_series` index (unhandled → 500, partial writes committed) AND a latent next-boot `ensureUniqueActiveSeriesIndex` crash.

**Why:** the unique index is partial on `active:true`; reviving must respect the "one active per series" invariant the index encodes — see [[project_unique_index_needs_boot_dedup_migration]].

**How to apply:** on any heal/revive/reactivate path that sets `active:true` (or any write that re-enters a partial-unique-index predicate), demand a pre-check that no other row already satisfies the predicate for that key, and a test fixture with a coexisting healthy-active sibling on the same series. `mostRecentPerSeries` keeping a row is NOT sufficient — the dropped siblings stay active. The item-side heal (`healDuplicateCalendarItems`) is safe because it only ever moves rows OUT of the predicate (→ trash).
