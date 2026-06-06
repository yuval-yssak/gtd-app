---
name: sanitize-for-status-two-variants
description: items.ts has TWO sanitize helpers with opposite semantics; new write paths often copy the wrong (silently-stripping) one
metadata:
  type: project
---

`routes/v1/items.ts` exposes two status-field sanitizers with deliberately opposite semantics; new `/v1` write paths (e.g. claude apply) keep copying the wrong one.

- `sanitizeForStatus(item)` (items.ts ~634): UNCONDITIONALLY deletes any status-incompatible field. Used ONLY by `POST /complete` where the caller explicitly asked for disposal and no field conflict is possible.
- `sanitizeStaleFields(merged, callerRaw)` (items.ts ~614): strips incompatible fields ONLY when they came from the existing row, and LEAVES caller-supplied incompatible fields so strict-mode Zod surfaces a `status_field_violation` 400. Used by `PATCH /v1/items/:id`.

**Why:** the codebase made a conscious choice (long comment at items.ts ~559-563/604-612) that silently dropping caller-supplied incompatible fields masks client bugs. PATCH-like merge handlers must surface the 400, not swallow.

**How to apply:** any new handler that merges a user-edited patch onto an existing item is a PATCH and must mirror `sanitizeStaleFields`, NOT the unconditional `sanitizeForStatus`. If a new helper's comment claims it "mirrors items.ts sanitizeForStatus," verify WHICH variant — the unconditional one is almost always wrong for a patch path. See [[project_v1_patch_trash_extra_drift]].
