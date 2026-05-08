---
name: v1 PATCH broadened-surface drift points
description: Two recurring drift bugs surfaced by the Phase 3 broadened PATCH /v1/items/:id — trash-transition contradicts COMPLETABLE_FROM, and `extra:{status,field}` is silently dropped from status_field_violation responses.
type: project
---

When reviewing /v1/items PATCH (or any v1 endpoint that catches `OperationValidationError`):

1. **Trash transitions via PATCH contradict the public-API design intent.** `COMPLETABLE_FROM` in items.ts has a comment explaining why `trash` is intentionally NOT in the public-API surface ("undeleting requires the in-app UI"). Phase 3 broadened PATCH lets `{ status: 'trash' }` through unconditionally because the matrix permits it. There's no `/v1/items/:id/restore` either — once a caller trashes via PATCH they're stuck. Either narrow PATCH's status set, or drop the `COMPLETABLE_FROM` "no public trashing" comment.

   **Why:** The two surfaces (`POST /complete` and `PATCH`) silently disagree about policy. New endpoints copying the COMPLETABLE_FROM comment will inherit a stale rationale.

   **How to apply:** When reviewing public-API mutation surfaces, check for status-set comments that predate the broader matrix-driven validation. Flag the policy contradiction.

2. **`OperationValidationError.failure.extra` is silently dropped in route responses.** The PatchError type (and the route's response builder) propagate `code`, `message`, `path` — but never `extra: { status, field }`. The route comments on the test file claim "`extra: { status, field }` carries the offending cell so callers can branch on it" — but the route never surfaces it. Easy fix: add `extra` to the response when present.

   **Why:** Documented contract says callers can programmatically branch on `extra`; in practice they can only string-match the message. Two sources of truth for the same surface.

   **How to apply:** Whenever a v1 route catches `OperationValidationError` and re-emits a 400, verify the response includes `extra` for `status_field_violation` codes. Phase 2 reassign/operations/routines may have the same gap.
