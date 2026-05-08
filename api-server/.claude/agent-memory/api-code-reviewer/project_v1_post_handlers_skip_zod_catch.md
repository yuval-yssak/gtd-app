---
name: /v1/* POST handlers often skip OperationValidationError catch
description: New /v1/* POST handlers tend to call `applyAndPublishOperation` without try/catch, while their PATCH siblings catch `OperationValidationError`. PATCH-only catching is fragile — flag asymmetry on review.
type: project
---

PATTERN: when a new /v1/* router lands, the PATCH handler catches `OperationValidationError` and maps it to a structured 400 (because the PATCH body merges with existing state and Zod-validation is a real concern). The POST handler often does NOT — the assumption is that the route's parser is strictly tighter than the entity's Zod schema, so an `OperationValidationError` on POST is unreachable.

This was the case in `/v1/people` and `/v1/work-contexts` at Phase 2 step 3. The routine router avoided the trap by extracting `applyRoutineWrite` (a helper used by both POST and PATCH) — that's the correct shape.

**Why:** the "POST parser tighter than schema" invariant is fragile. If someone widens the Zod schema OR narrows a route parser later, an unhandled Zod failure on POST becomes a 500 to the integration instead of a clean 400. The unified-error-shape contract for /v1 expects 400 with `{error, code, path?}`.

**How to apply:** on every new /v1/* POST handler, ensure either (a) it shares an `applyEntityWrite`-style helper with PATCH that catches `OperationValidationError`, or (b) the POST handler explicitly catches and maps. Flag asymmetry where PATCH catches but POST doesn't, even if today's tighter route parser makes the throw unreachable.
