---
name: denormalised-marker-read-clear-race
description: Denormalised "needs work" flags on items get cleared by batch $unset over ids read earlier in the same pass — a concurrent write between read and clear is silently erased
metadata:
  type: project
---

When a sweep reads a page of rows carrying a "needs work" flag, decides some are false positives,
and then clears them with a batched `updateMany({_id: {$in: ids}}, {$unset: {flag: ''}})`, the
clear is keyed on the id only — not on the state the decision was made from. Any write that lands
between the `find` and the `updateMany` sets the flag and then has it immediately erased.

**Why:** the usual justification written in the comment is "a concurrent edit re-marks it through
the DAO anyway" — which is only true for edits AFTER the clear. The read→decide→clear window is
exactly where this fails, and the failure is silent and permanent: the item is never re-selected
until something else happens to touch it. Found on `items.briefStale` / `clearBriefStaleBatch`
(2026-09-21), where the single-item sibling `clearBriefStale` DID carry an `updatedTs` guard, so
the asymmetry was visible in the same file.

**How to apply:** whenever a review turns up a "clear the flag on rows I just examined" batch, check
that the clear is conditioned on the same anchor the decision used (`updatedTs`, a version, or the
flag value the read saw) — in this repo `updatedTs` is the standing conflict anchor, and a
per-item guarded clear or an `$in` filter that also pins `updatedTs` per id is the fix. Lean on the
project's own asymmetry rule: a spurious `true` is cheap, a lost `true` strands the row forever.
