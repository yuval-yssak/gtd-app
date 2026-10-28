---
name: collapsed-entry-edit-drops-entry
description: Editing the representative member of a collapsed review entry (routine: pseudo-entry) can make the entry itself ineligible mid-edit; the reconcile then unmounts the card under the user. Check single-member collapses + text autosave.
metadata:
  type: project
---

The Weekly Review calendar stage collapses a routine's occurrences into one `routine:<id>` entry; a `modified` exception splits an occurrence out as its own entry. Once a card EDITS an occurrence in place (2026-10-28 RoutineReviewCard redesign), any write that records an exception changes eligibility. With text autosave (on for items without attendees) this happens mid-typing, not at decision time. When the routine has exactly one collapsed occurrence (yearly/quarterly routine inside the horizon, series near UNTIL), the routine entry vanishes, the reconcile drops it, the card unmounts and the exception re-appears at the end of the walk.

**Why:** pinning the shown row in useState and retiring it at decision time only covers the decide path; the reconcile acts on every refresh.

**How to apply:** whenever a review card writes to a member of a collapsed/derived entry, ask "can this write change the entry's own eligibility before the decision lands?" Test the one-member case and the autosave path, not only the explicit Save path. Also: a story asserting "series actions lock over the edit" via a Title type is false when text autosave is on (isDirty excludes text then).
