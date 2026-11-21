---
name: item-sidecar-cascade-sites
description: Item hard-delete sidecar cascades (itemBriefs, claudeAsks, ...) are hand-called at 4+ sites incl. operator scripts; a new item sidecar repeatedly misses the scripts
metadata:
  type: project
---

Every per-item sidecar collection (itemBriefs, and since 2026-11 claudeAsks) must be
cascaded on item hard-delete and cross-account reassign. The cascade is invoked by hand
at: `lib/referenceCascades.ts` (pipeline deletes), `lib/reassignEntity.ts` (both the
normal and alreadyMoved branches), AND the operator scripts `scripts/deleteCloneRoutines.ts`
and `scripts/deleteCalendarItems.ts`, which bypass the pipeline. The ask-claude change
(2026-11-21) added the claudeAsk cascade to the first two but not the scripts.

**Why:** there is no single "drop item sidecars" entry point shared by lib and scripts,
so each new sidecar is added wherever the author searched — the scripts are missed.

**How to apply:** when a diff adds a per-item sidecar, grep `cascadeItemBriefRemoval`
and confirm the new cascade appears at every hit; recommend one shared
`cascadeItemSidecarRemoval` helper. Related: [[reassign-alreadymoved-branch-skips-side-effects]],
[[sidecar-write-bypasses-owner-marker]].
