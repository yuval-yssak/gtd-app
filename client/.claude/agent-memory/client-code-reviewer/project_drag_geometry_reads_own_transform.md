---
name: drag-geometry-reads-own-transform
description: Drag/reorder code that reads getBoundingClientRect on the element it also translateY's feeds its own shift back into drop/wall math; e2e passes only because release beats the CSS transition.
metadata:
  type: project
---

Native drag code (first seen in the Next Actions reorder, 2026-10-23) put `transform: translateY(var(--drag-shift))`
AND the `data-item-id` rect anchor on the same element, so every per-frame `getBoundingClientRect()` returned
already-shifted geometry. Result: the section-wall check flagged the top/bottom slot as "outside" once the
displaced edge row finished its 0.12s transition, so drag-to-top/bottom snapped back for any row taller than ~48px.

The e2e spec (CDP touch, Playwright mouse) released ~16ms after the last move, i.e. mid-transition, so it was green.

**Why:** geometry-under-transform bugs are invisible to node reducer tests (they feed static rects) and to e2e that
releases instantly.

**How to apply:** in any drag/sort review, check which element carries the transform vs which element is measured;
demand measurement of an untransformed wrapper (or subtract the shift), and an e2e that pauses > transition time
before release at the section edges. Related: [[e2e-asserts-textcontent-for-visual-bug]].
Also seen same review: date-collapse fixtures with explicit offsets (`T12:00+02:00`, `T15:00Z`) fail under
Asia/Tokyo / UTC+14 — client vitest has no pinned TZ; ask for local-built fixtures or a pinned TZ.
