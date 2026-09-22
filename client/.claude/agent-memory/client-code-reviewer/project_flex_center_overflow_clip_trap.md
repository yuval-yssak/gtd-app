---
name: flex-center-overflow-clip-trap
description: Adding overflow-y:auto to an existing align-items:center flex container silently clips content above scrollTop 0 — recurring in weekly-review stage layout work
metadata:
  type: project
---

When a scroll fix adds `overflow-y: auto` to a flex container that already has
`align-items: center` (or `justify-content: center` on a column), content taller than the
container is centered *past the scrollport origin*: its top sits at a negative offset and
`scrollTop` cannot go below 0, so those pixels are permanently unreachable. Before the
`overflow` was added the same content merely painted outside the box and stayed readable, so
the regression looks like a pure improvement in review.

**Why:** this exact trap shipped in the weekly-review `.centeredArea` during the
"scroll the gutters" rework (2026-09-22). Measured repro: a 176px card in a 138px area put the
card top at −19px with `scrollTop: 0`; `document.elementFromPoint` at the card's top pixel
returned the ancestor, not the card. The author's own e2e passed because every test exercised
the tall-content path through the *other* wrapper (`.cardScroller`, which is
`flex-direction: column` + `align-items: center` — centering on the cross/horizontal axis, so
it is safe), never through `.centeredArea`.

**How to apply:** on any diff that adds `overflow-*: auto|scroll` to a flex/grid container,
check the centering properties on the *block* axis of that container. Column + `align-items`
is horizontal centering and safe; column + `justify-content: center` and row +
`align-items: center` are the dangerous pairs. Fix is `align-items: safe center` (or
`margin: auto` on the child with `flex-start` on the parent) — both verified to restore
`top: 0` and the full `scrollHeight`. Reachable in production at short viewports (landscape
phone ~380px) even for content that "obviously fits" on desktop, so a desktop-only e2e will
not catch it. Relates to [[e2e-asserts-textcontent-for-visual-bug]]: only geometric probes
find this.
