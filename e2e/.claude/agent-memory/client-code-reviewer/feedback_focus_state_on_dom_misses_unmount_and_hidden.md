---
name: feedback-focus-state-on-dom-misses-unmount-and-hidden
description: Roving/region focus tricks (imperative tabIndex flip, getClientRects visibility filter, :focus-visible forwarding) each break on a path Chromium e2e never runs
metadata:
  type: feedback
---

Keyboard-region work (exp/keyboard-regions, 2026-10-23) shipped three latent focus bugs, all proven by probe:

1. **"tabIndex=-1 while focus is inside, reset on blur"** gets stuck at -1 when the focused child UNMOUNTS (self-removing "+N more"/"Show fewer" chips, virtua scrolling a focused row away). React's `onBlur` on the container does not fire for an unmounted child (native Chromium focusout does, React's does not — probed with a real React 19 bundle). The region silently leaves the Tab order. Prefer a transient flip only during the Shift+Tab keydown.
2. **`getClientRects().length > 0` as "visible"** passes MUI keep-mounted closed drawers: Modal root + Slide child are `visibility: hidden`, which still has boxes; `.focus()` on them is a no-op, so an F6-style cycle sticks forever at <900px. Use `checkVisibility({ visibilityProperty: true })`.
3. **Forwarding focus only when the container `:matches(':focus-visible')`** fails in WebKit after programmatic focus that follows a mouse click (Chromium/Firefox: true; WebKit: false). The e2e project is Chromium-only, so it can't see it.

**Why:** all three pass the Chromium desktop e2e that ships with the change.
**How to apply:** when a diff stores focus state on the DOM, uses a visibility heuristic, or gates on `:focus-visible`, ask for: an unmount-while-focused case, a narrow-viewport (<900px) case, and a WebKit or explicit keyboard-entry-flag path. Also check F6-like keys that bypass the modal guard letter shortcuts honour. Related: [[feedback-chrome-toggles-enter-focus-restore-surface]].
