---
name: status-field-strip-scattered
description: Status-transition field stripping is duplicated across ~9 hand-rolled destructure lists; fixes land on one path and miss siblings, leaking matrix-disallowed fields that 400 /sync/push and jam the offline queue.
metadata:
  type: feedback
---

When reviewing any change to how an item's status-specific fields are stripped on a status transition, check ALL producers of that status's snapshot, not just the one in the diff.

**Why:** The client has two families of status-transition helpers, each with its own hand-rolled destructure-strip list:
- `clarifyTo*` in `client/src/db/itemMutations.ts`
- `apply*Form` / `mergeFormsIntoItem` in `client/src/components/editItemDialogLogic.ts` (editor dialog; `mergeFormsIntoItem` branches on the *target* status, so it handles transitions, not just in-place edits)

The server enforces a strict status→field matrix (`api-server/src/schemas/operations/item.ts` `STATUS_FIELD_MATRIX`). A snapshot carrying a disallowed field (e.g. `expectedBy` on a `calendar` item) 400s `/sync/push` and permanently jams that device's offline queue — every later edit is stuck behind the poisoned op (observed on staging July 2026). The `apply*Form` helpers are especially leaky: they strip only a subset and pass everything else through `...rest`, so cross-status transitions in the editor leave many disallowed fields.

Bug fixes here keep landing as spot patches on a single destructure list (e.g. adding `expectedBy: _eb` to `clarifyToCalendar` only) and miss the ~4 sibling paths with the identical leak.

**How to apply:** When a diff strips a field for a status transition, flag every other `clarifyTo*` and `apply*Form` for the same target status and confirm they strip it too. Push for the real fix: one shared `stripFieldsNotAllowedForStatus(item, status)` helper keyed off a client mirror of `STATUS_FIELD_MATRIX`, called at the tail of every transition helper — per CLAUDE.md "Abstraction" (repeated pattern 2+ times must be extracted). A server-side sanitizer may mask these as latent rather than live, but the client invariant should still be enforced in one place.
