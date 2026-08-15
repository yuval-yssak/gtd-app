---
name: new-list-chrome-skips-empty-gate
description: New list-page chrome (tabs, view toggles, filter bars) ships ungated while the sibling search field right above it is gated on a non-empty collection — compare the two gates in the same JSX
metadata:
  type: feedback
---

When a list route gains a new always-on control surface — URL-backed tabs, a List/Week view
toggle, a filter row — it gets rendered unconditionally, sitting directly under a search field
that *is* gated (`{(items.length > 0 || Boolean(q)) && <TextField/>}`). Result: the first-launch
"no routines yet" screen shows "Next Action (0) / Calendar (0)" tabs and a view toggle over an
empty page, and the `isInitialSyncing` skeleton renders *below* a live tab bar.

**Why:** the gate lives on the element above in the same JSX block, so the asymmetry is invisible
unless you read both conditions together. This is the same failure shape as the header search
button on empty list pages — the pattern recurs whenever chrome is added rather than replaced.

**How to apply:** on any diff adding a control to a list route's header area, find the nearest
already-gated sibling and check whether the new control needs the same gate. Also check where the
`ListSkeleton` / empty-state branch renders relative to the new chrome.

Related: [[search-button-on-empty-list-pages]], [[conditional-render-gate-loses-coverage]]
