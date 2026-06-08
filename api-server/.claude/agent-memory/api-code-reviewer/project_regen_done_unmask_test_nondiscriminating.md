---
name: regen-done-unmask-test-nondiscriminating
description: The regen "done item not duplicated alongside live item" regression requires a SEPARATE co-located live row; tests that just flip the only item to done don't discriminate the fix from the bug.
metadata:
  type: project
---

`regenerateFutureRoutineItems` (src/lib/routineItemRegeneration.ts) had a regression where a `done` item's date claim could be unmasked by a co-located live item, spawning a duplicate. The fix scopes the veto query to disposed-only (`status: { $nin: ['trash','calendar'] }`) so this routine's own live items never enter the veto set.

The bug ONLY manifests when date D simultaneously holds a `done` item AND a separate live `calendar` item of the same routine. The old buggy code claimed D from the done row, then deleted every live date from the veto set → unmasked D → recreated a live row beside the done one.

**Why:** A test that takes the single generated item and flips it to `done` (no separate co-located live row) leaves zero live items on that date. Both old and new code produce "no live row recreated" there, so such a test passes under the bug too — it does not discriminate the fix.

**How to apply:** When reviewing regen/dedup tests claiming to cover "done kept even alongside a live item," require the fixture to insert a SECOND live row on the same date (e.g. manually insert a drifted live item whose date equals the done item's date), then assert exactly the done row survives and the live row is trashed with no recreation. Flag titles that say "alongside a live item" when no second live row exists. Related: [[project_create_on_miss_no_dedupe]], [[project_routine_item_generation_test_flake]].
