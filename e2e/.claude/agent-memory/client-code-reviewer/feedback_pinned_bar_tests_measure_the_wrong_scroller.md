---
name: pinned-bar-tests-measure-the-wrong-scroller
description: "Pinned-position e2e tests assert bar y-coordinates without ever scrolling, and check <main> overflow instead of the document — both pass while the bar is trivially unpinnable"
metadata:
  type: feedback
---

An e2e test that proves a bar is "pinned at one screen position" must actually attempt to scroll before
re-measuring. Reading `boundingBox().y` at several app states only proves the *layout* is stable, not
that the position survives user input.

**Why:** the weekly-review pinned-bar spec compared the bar's `y` across long item / short item / empty
state / next stage and asserted `main.scrollHeight - main.clientHeight <= 1` — all four passed while
`window.scrollTo(0, 99999)` moved the bar 56px, because the overflow lived on the *document*, not on
`<main>`. The chosen scroller was the one the diff introduced, so it was guaranteed clean.

**How to apply:** demand three things in any "stays put" test: (1) a `window.scrollTo(0, 99999)` (or
mouse wheel over the non-scrolling chrome) followed by a re-measure asserting the bar did not move;
(2) overflow assertions on `document.documentElement`, not only on the intended scroll container;
(3) the discrimination guard that content genuinely overflowed — this batch got (3) right via
`Math.max(firstItemOverflow, secondItemOverflow) > 0`, which is the pattern to keep. Related:
[[viewport-fitted-page-exposes-latent-fixed-position]], [[dismiss-button-tests-pass-by-timeout]].
