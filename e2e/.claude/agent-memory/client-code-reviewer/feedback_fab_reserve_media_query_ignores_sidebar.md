---
name: fab-reserve-media-query-ignores-sidebar
description: Media queries that reserve space for the viewport-fixed quick-capture FAB are derived from viewport width alone, ignoring the 15rem desktop sidebar — leaving a broken mid-width band
metadata:
  type: feedback
---

Any `@media (max-width: Nrem)` written to gate space reserved for the **fixed** quick-capture FAB
(`position: fixed; right: 1.25rem`) gets its breakpoint derived from viewport width vs. a centered
`max-width` bar. That derivation silently assumes the bar is centered in the *viewport*.

It is not. Above `56.25rem` the app shell inserts a **15rem permanent drawer** plus `1.5rem`
`mainContent` padding, so a `40rem` centered bar's right edge is `(viewport + 55rem)/2`, not
`(viewport + 40rem)/2`. Overlap therefore persists ~15rem further right than the naive math says.
Concretely: reserve gated at `max-width: 52rem` when the true desktop overlap threshold is
`64.5rem` leaves **900px–1032px broken** — exactly the narrow-laptop / half-screen-window band.

**Why:** the two viewports that get e2e-pinned are 1280px (clears everything) and 390px (below the
breakpoint, reserve applies). Both pass. Nothing exercises the band between the sidebar breakpoint
and the true overlap threshold, and the band only exists *because* the sidebar appears there.

**How to apply:** on any diff that narrows a FAB/overlay reserve behind a media query, recompute the
threshold twice — once for the mobile (no-sidebar) layout and once for the desktop (sidebar)
layout — and check the media query covers the larger of the two. Cheap pin: an e2e assertion at a
width just above the sidebar breakpoint (e.g. 960px) asserting the FAB and primary-button boxes do
not intersect. Related: [[viewport-fitted-page-exposes-latent-fixed-position]],
[[pinned-bar-tests-measure-the-wrong-scroller]].
