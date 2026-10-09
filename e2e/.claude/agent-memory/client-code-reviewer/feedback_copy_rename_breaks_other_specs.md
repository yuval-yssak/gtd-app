---
name: feedback-copy-rename-breaks-other-specs
description: User-visible copy/brand renames break text locators in untouched e2e specs, and source-grep unit tests pass via substring overlap
metadata:
  type: feedback
---
Copy/rename diffs (e.g. the 2026-09-27 "GTD" -> "Done" rebrand) update the new spec but leave regex `getByText(/...old copy.../)` locators in OTHER specs (calendar-disconnect*, found 2) that will time out. Also, source-text unit tests like `toContain('name: APP_NAME,')` are satisfied by `short_name: APP_NAME,` — substring overlap makes them non-discriminating.

**Why:** the author greps client/src for the old string but not e2e/, and lint/typecheck/unit runs never exercise the other specs.

**How to apply:** on any copy change, grep `e2e/*.ts` for every old phrase; for source-grep assertions, check whether a sibling line contains the asserted substring. Also check legal-text edits bump `LEGAL_EFFECTIVE_DATE`. Related: [[feedback-legal-text-claims-vs-code]].

Same failure for CSS Module class renames: e2e specs locate by `[class*="<localName>"]` (Vite's default `_<local>_<hash>` keeps the local name), so renaming `.previewClickable` -> `.pagePreview` (2026-10-09) silently broke weekly-review-card-fits.spec.ts while the changed specs passed. Grep e2e/ for every renamed class name too.
