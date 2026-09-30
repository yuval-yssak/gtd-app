---
name: feedback-css-module-vs-typography-emotion
description: CSS-module rules on an MUI Typography element lose to its runtime emotion variant styles; fixes tend to move only the property that was noticed (margin) and leave font-weight dead
metadata:
  type: feedback
---

A CSS-module class on a `<Typography>` loses any property the variant also sets (margin reset, font-weight, font-size, line-height), because emotion injects its equal-specificity class later. Colour usually survives (variants don't set it). 2026-10-01 landing page: a round fixed margins via `sx` after a screenshot, but `.title {font-weight:700}`, `.sectionTitle {600}` and `.tagline {400}` stayed dead (computed 400/400/500).

**Why:** Screenshot-driven fixes address the gap someone saw; weight differences don't stand out in a screenshot.

**How to apply:** For every CSS-module class on a Typography (or other emotion-styled MUI component), list its properties and flag any the variant also defines. Verify with `getComputedStyle` in a throwaway Playwright probe rather than trusting the claim. Related: [[feedback-viewport-fitted-page-exposes-latent-fixed-position]] (same emotion-beats-module cascade).
