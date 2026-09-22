---
name: new-scrollport-leaves-inner-scroller
description: Moving the scroll to a new wrapper leaves the old inner overflow-y:auto in place on some cards, so the new scrollport is inert there
metadata:
  type: project
---

When a change relocates scrolling from an inner card to a new full-width wrapper, the inner
card's own `overflow-y: auto` + `min-height: 0` must be removed *and* the card given
`flex-shrink: 0` — on every card class, not just the one the author was looking at. A card that
keeps `min-height: 0; overflow-y: auto` and no `flex-shrink: 0` shrinks to exactly fill the new
wrapper, so the wrapper measures `scrollHeight - clientHeight === 0` and is inert: the scroll
still happens inside the card, and whatever the wrapper was added to fix (dead gutters) is
still broken there.

**Why:** in the weekly-review gutter-scroll rework (2026-09-22), `.editorCard` was correctly
converted (`overflow`/`min-height` dropped, `flex-shrink: 0` added) but `.checklistCard`
(`InboxChecklistStage`) was wrapped in the new `.cardScroller` while keeping its old inner
scroll. Measured: wrapper overflow 0, card overflow 646px. The stage looked "done" because the
JSX wrapper was present at all five call sites.

**How to apply:** grep for every card class rendered inside the new wrapper, not just the
shared one. The tell is a card class that still carries `overflow-y: auto` after the change.
Also check the reverse direction — stale comments elsewhere that still name the old scroller
(e.g. `RoutineReviewCard.module.css` referenced "the card's own scroll (.editorCard)" after
`.editorCard` stopped scrolling).
