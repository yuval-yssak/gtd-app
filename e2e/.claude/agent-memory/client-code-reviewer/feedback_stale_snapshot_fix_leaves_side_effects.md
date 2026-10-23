---
name: feedback-stale-snapshot-fix-leaves-side-effects
description: Fixing a render-snapshot race with functional setState updaters leaves the sibling non-state side effects (autosave controller reset, seed writes) still decided from the stale snapshot
metadata:
  type: feedback
---

When an effect reads a render-time ref snapshot (`formRefs.current`) and a same-tick event handler
has already queued a newer local edit, the usual fix is "make every setter functional and only
write what the merge changed". That repairs React state but NOT the imperative side effects in the
same effect that are still decided from the snapshot. Canonical case (ItemEditorBody live merge,
2026-10-23): `textAutosave.reset(incoming)` gated on snapshot-merged text cancels the debounce for
a keystroke typed in the same tick. The field keeps the char (functional updater) but the
controller thinks it is clean, so blur/unmount flush is a no-op: silent loss, worse than the old
visible overwrite.

**Why:** a fix verified only through the state path (unit tests of the pure apply helper + the
reproducing e2e) looks complete; the controller/ref side of the same decision has no test.

**How to apply:** for any "functional updates over current state" race fix, list every
non-setState call in that effect (controller.reset, ref writes, seed setters, conflict flags) and
ask what each does when current != snapshot. Prefer write-through refs (handler writes the ref
synchronously) so the effect never sees a stale snapshot at all. Related: [[refresh-resolves-before-commit]].
