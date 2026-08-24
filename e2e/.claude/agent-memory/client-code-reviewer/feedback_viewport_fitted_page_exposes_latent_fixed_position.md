---
name: viewport-fitted-page-exposes-latent-fixed-position
description: A new `height: calc(100dvh - inset)` page turns any in-flow app-shell sibling (FAB, snackbar) into document overflow — the "pinned" bar then scrolls; verify computed position, not the CSS source
metadata:
  type: feedback
---

When a page introduces a viewport-fitted root (`height: calc(100dvh - var(--inset))`) to pin a bottom
action bar, measure `document.documentElement.scrollHeight` vs `clientHeight` **with that page mounted**
and compare against a plain list page. Any sibling rendered inside `<main>` that is meant to be
`position: fixed` but computes to `static`/`relative` now stacks *below* a full-height child and pushes
the document past the viewport — the bar scrolls away and the whole "one fixed screen position"
guarantee silently fails.

**Why:** the weekly-review pinned-action-bar batch hit exactly this. `QuickCaptureFab.module.css` sets
`.fab { position: fixed }`, but MUI's emotion class (`css-*`, same 0,1,0 specificity, injected later in
the cascade) wins, so the FAB computes `position: relative` app-wide. That was invisible while every
page's content already scrolled; the moment `.wizardRoot` became exactly `100dvh - inset`, the in-flow
56px FAB made `main` 776px tall in a 720px viewport. Window scroll moved the "pinned" bar 56px.

**How to apply:** for any diff adding `100dvh`/`100vh`-fitted layout, (1) read the *computed* position of
every fixed-intent overlay in the app shell rather than trusting the CSS module source — MUI emotion
classes routinely beat CSS Module rules at equal specificity, so a doubled selector (`.fab.fab`) or an
`sx` override is the fix; (2) assert on document-level overflow, not just the scroll container the diff
introduced — a test that only checks `<main>`'s `scrollHeight - clientHeight` passes while the document
behind it scrolls. Related: [[feedback-pinned-bar-tests-measure-the-wrong-scroller]].
