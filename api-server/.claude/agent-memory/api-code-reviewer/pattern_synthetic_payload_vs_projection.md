---
name: pattern-synthetic-payload-vs-projection
description: MCP/response-decoration features get unit-tested on hand-built payloads and miss that the /v1 projection allowlist never returns the field they inspect
metadata:
  type: project
---

Recurring blind spot: logic in the MCP layer (url stamping, fieldGuidance, ...) that inspects a `/v1` response
is unit-tested with synthetic objects. A field the public projection (`routes/v1/projections/*`) never emits
then looks "present" in tests and is always "missing" in production. Seen 2026-10-06: fieldGuidance flagged
`location` on every calendar item because `PublicItem` omits GCal-owned fields, while all tests were green.

**Why:** the projection is an allowlist, and GCal-owned keys are deliberately left out of it.
**How to apply:** for any MCP decoration or `/v1` consumer that reads a field, check the projection allowlist and
require at least one test that drives the real route for the positive case (field set → no flag), not only synthetic payloads.
