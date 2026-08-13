---
name: read-only-field-write-path-gaps
description: A field added "read-only on /v1" still needs an audit of every OTHER server-side snapshot producer (v1 PATCH merge, reassign mirror-create, /v1/operations/batch) — omission there is silent data loss, not read-only-ness.
metadata:
  type: project
---

When a new optional entity field is deliberately excluded from the `/v1` PATCH/POST `ALLOWED_FIELDS`
allowlist ("app/sync-driven only"), that does NOT make the field safe. Every server-side code path
that builds a full snapshot and pushes it through `applyAndPublishOperation` performs a **full
document replace** (`applyEntitySnapshotOp` → `dao.replaceById`), so any producer that forgets to
carry the field forward silently erases it.

Audit these producers on every such change:
1. `/v1/*` PATCH handlers — safe only when they spread `...existing` before the patch.
   (`workContexts.ts` PATCH builds `{ ...existing, name, updatedTs }` — carries the field.)
2. `reassignEntity.ts` `createPersonForUser` / `createWorkContextForUser` — these enumerate
   "display fields" explicitly with `...(source.X !== undefined ? {X} : {})`. A new field must be
   added here or the mirror row silently drops it on cross-account reassign.
3. `POST /v1/operations/batch` — accepts a caller-supplied full snapshot and validates it against
   the same strict Zod schema. Widening the schema for the sync client implicitly opens the field
   to public-API bearer callers too, bypassing the PATCH allowlist. "Read-only on /v1" is only
   true if you also consider batch.

**Why:** the strict snapshot schemas are shared between `/sync/push` and `/v1/operations/batch`;
the field-level allowlists live only on the hand-written REST handlers. The two do not agree by
construction.

**How to apply:** on any new optional field on `PersonInterface` / `WorkContextInterface` /
`RoutineInterface`, grep for the interface name outside `types/` + `tests/` and check each
snapshot-construction site. Relates to [[writable-fields-drift]] and
[[snapshot-replace-defeats-lww-on-concurrent-edits]].
