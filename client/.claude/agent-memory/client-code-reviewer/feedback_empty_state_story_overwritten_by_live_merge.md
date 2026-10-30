---
name: empty-state-story-overwritten-by-live-merge
description: Editor stories that pass a blank/modified entity via args while the provider lists the real row get silently "repaired" by the live-merge effect on mount.
metadata:
  type: feedback
---

Autosaving editors (WorkContextEditorBody, PersonEditorBody, ...) look up the live row in the AppData list and run a mount-time live-merge effect: if the live name differs from the seed and the field is "clean", they adopt the live name. A story like `EmptyName: { args: { workContext: { ...sample, name: '' } } }` with a decorator that lists the unmodified `sample` therefore renders the real name, not the empty/error state. The author's "checked visually" claim missed it twice (dialog + page stories, 2026-10-30).

**Why:** the story exists to pin a visual state; when the effect overwrites it, the story pins nothing.

**How to apply:** for any story overriding an entity arg, check that the provider list (both filtered and `all*` lists) contains the *same overridden* row. Related: [[stale-row-snapshot-write-back]].
