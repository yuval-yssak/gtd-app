---
name: humanize-enum-via-existing-label-map
description: New display/presenter code leaks raw lowercase enums (energy low/medium/high, status) because a switch falls through to a String() default instead of reusing the canonical label map that already exists elsewhere in the app.
metadata:
  type: feedback
---

When reviewing a new presenter/formatter that maps entity fields to display strings, check every enum-valued field has an explicit humanizing case. The trap: a `switch` with a `default: String(patch[field] ?? '')` silently renders the raw lowercase enum for any field that lacks a `case`.

**Why:** In the Phase 3 Claude review presenter (`proposalPresenter.ts`), `energy` had no `case`, so it rendered `low`/`medium`/`high` verbatim while STATUS_LABELS humanized status right next to it. The canonical `energyLabels: Record<EnergyLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' }` already lived in `routes/_authenticated/next-actions.tsx` — the new code duplicated the concept badly instead of reusing it. No unit test covered `energy`, which is what let it ship.

**How to apply:** For any new field-display module, (1) cross-check each enum field against an existing label map elsewhere in the repo (grep for `Record<XxxLevel` / `Labels`) and reuse/lift it rather than re-deriving; (2) flag a `default: String(...)` fall-through that can swallow enums; (3) require a unit test per enum field's humanized output — the missing test is the tell. Relates to [[react-keys-by-display-name]] (lossy string handling of entity fields).
