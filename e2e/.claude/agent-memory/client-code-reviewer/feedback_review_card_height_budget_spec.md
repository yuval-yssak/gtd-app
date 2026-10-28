---
name: review-card-height-budget-spec
description: Anything that adds a row to the weekly-review card (FocusStage/ClarifyStage editor) breaks weekly-review-card-fits.spec.ts's zero-overflow assertion; authors run only weekly-review.spec.ts
metadata:
  type: feedback
---

Adding UI to the review card's embedded `ItemEditorBody` (e.g. opting the Position row back in, 2026-10-28) overflows
`e2e/weekly-review-card-fits.spec.ts` ("a next action with notes and no brief shows its metadata without scrolling",
1920x929, `overflow <= 1`; the Position row cost 62px). Authors report "weekly-review.spec.ts passes" and never run it.

**Why:** the card-fits spec is the only height-budget guard and lives in a separate file nobody associates with the change.
**How to apply:** for any diff that adds a control inside a review card, run `weekly-review-card-fits.spec.ts` and
`weekly-review-dense-fields.spec.ts` yourself. Related: [[viewport-fitted-page-exposes-latent-fixed-position]].
