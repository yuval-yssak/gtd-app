---
name: aria-label-collides-with-getbylabel
description: Adornment buttons whose aria-label embeds the field label ("Clear Expected by") make Playwright getByLabel('Expected by') resolve to 3 elements (substring + aria-label on ANY element) and strict-fail every existing spec.
metadata:
  type: feedback
---

Playwright's `getByLabel` matches the `aria-label` of any element (not just inputs), case-insensitive substring by default. A button named `Clear <field label>` / `Pick <field label>` collides with every `getByLabel('<field label>')` in e2e. `{ exact: true }` is no escape for required MUI fields: the hidden ` *` asterisk is part of the label text, so exact returns 0.

**Why:** Caught 2026-10-03 on the shared DateField/TimeField refactor; verified with a setContent repro (count 3, strict-mode violation). Static-markup unit tests and typecheck stay green, so only the (unrun) e2e suite would surface it.

**How to apply:** Whenever a component adds named controls next to a labelled input, grep e2e for `getByLabel('<label>')`. The fix that keeps role names intact is a plain `title` attribute on an icon-only button: the accessible name becomes the title, and getByLabel ignores it. Do not use an MUI Tooltip; it copies the title into aria-label. Related: [[revert-check-regression-tests]]
