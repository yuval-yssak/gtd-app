---
name: feedback-app-css-stylelint-claim-unverified
description: During the Base UI facelift, `lint:css` only globs src/designSystem; "stylelint clean on touched app modules" claims hide real violations — run stylelint on the touched modules yourself.
metadata:
  type: feedback
---

Batch 3b claimed "stylelint on the touched app modules is clean", but running `npx stylelint <touched>.module.css` showed a real `text-align: left` (MarkdownPreview td) and new `comment-empty-line-before` hits, buried among the expected plan-noted noise (`:global(p)` type selectors, `cm-*` class names, `composes`).

**Why:** `npm run lint:css` globs only `src/designSystem/**/*.css` until Phase 2 widens it, so nothing in the hook covers the app-CSS override block, and authors eyeball it.

**How to apply:** For any facelift batch touching app `*.module.css`, run stylelint on exactly those files and filter out `selector-class-pattern|selector-max-type|property-no-unknown (composes)`; whatever remains is real. Also check physical shorthands (`padding: a b c d` with asymmetric inline values) that the gate cannot see. Related: [[feedback-chip-tone-applied-unselected]].
