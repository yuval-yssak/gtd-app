---
name: sync-push-strips-matrix-fields
description: /sync/push heals matrix field-drift by stripping disallowed status-specific fields before strict validation; /v1 still 400s. Review checklist for this asymmetry.
metadata:
  type: project
---

`/sync/push` runs `sanitizeItemSnapshot` → `stripDisallowedStatusFields` (schemas/operations/item.ts) on item create/update snapshots BEFORE strict Zod+matrix validation. It removes status-specific fields the STATUS_FIELD_MATRIX disallows for the declared status, logs a `console.warn`, and lets the op through. Zod-level `invalid_operation` still 400s.

**Why:** deployed clients shipped transitions that leave a disallowed field on the snapshot (e.g. `expectedBy` surviving nextAction→calendar). Under strict /sync/push this 400s the whole batch and *permanently jams* the device's offline queue — no client-side recovery. Observed live on staging (user 69ff231d…, 3 devices, 400-ing since 2026-07-13). Server-side strip heals already-queued poisoned ops with no user action.

**How to apply (review checklist when this area changes):**
- The strip is item-only + create/update-only (guarded on `op.entityType`/`opType`). Any new op type or entity must be re-checked against the guard.
- `done`/`trash` map to ALL_STATUS_SPECIFIC in the matrix → strip is a NO-OP there (archival preservation invariant, item.ts:144-148). A regression that strips done/trash fields is silent — demand a test: update→done carrying expectedBy+energy → 200, both persisted.
- `/v1` + `/v1/operations/batch` keep the strict `status_field_violation` 400 via the shared `validateOperation`→`assertStatusFieldRules`. Do NOT let `stripDisallowedStatusFields` leak into the v1/batch path — the 400 is intentional (API callers have no queue to jam).
- Interaction with `hydrateCalendarDetachSnapshots` is SAFE: detach reads GCal linkage off the existing DB row, never the incoming (stripped) snapshot. Stripping calendarEventId from an incoming calendar→active op is the shape the detach path already assumes.
- Stripping cannot rescue Zod-invalid snapshots (missing createdTs, empty title, bad status enum) — those still 400. So the strip does not mask genuinely malformed data, only orphaned matrix fields.
