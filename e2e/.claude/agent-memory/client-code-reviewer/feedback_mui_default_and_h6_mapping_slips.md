---
name: feedback-mui-default-and-h6-mapping-slips
description: MUI→DS ports slip on implicit MUI defaults (bare CircularProgress = 40px vs Spinner 24) and map Typography h6 to `subtitle` (1rem) instead of `titleSm` (1.25rem)
metadata:
  type: feedback
---

Recurring parity slips in the MUI→design-system migration batches:
- A bare `<CircularProgress />` (MUI default 40px) gets ported as `<Spinner />` with no size; DS default is 24. Every other port passes `size={40}`.
- `Typography variant="h6"` gets mapped to Text `subtitle` (subtitle1, 1rem/1.75rem) because of the shared h6 *element*; the size match is `titleSm` (1.25rem/2rem).
- Removing MUI also un-drops module rules emotion used to beat (font-weight/margin on Typography, no injectFirst in this app), so "unchanged" module classes become newly visible — call it out as a deliberate-or-not parity change.

**Why:** the batches claim density/visual parity; these pass typecheck, lint and e2e.
**How to apply:** for each removed MUI component, check what its omitted props defaulted to; check Text variant by size, not element. Related: [[feedback-css-module-vs-typography-emotion]].
