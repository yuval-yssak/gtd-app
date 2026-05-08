---
name: /v1/reassign bypasses applyAndPublishOperation
description: reassignEntity predates Phase 2 unified pipeline; uses recordOperation directly so SSE/web push/GCal pushback/webhooks/Zod do NOT fire on /v1/reassign or /sync/reassign. Phase 2 closed the deviceId-attribution leg only.
type: project
---

`/v1/reassign` is a thin wrapper around `lib/reassignEntity.ts`. That helper predates the Phase 2 `applyAndPublishOperation` pipeline and uses `recordOperation` directly. Practical consequences for any reassign op:

- **No `notifyChange` fan-out** — no SSE broadcast to live tabs, no web push, no webhook delivery, no GCal pushback dispatch (apart from the in-line GCal create/delete reassignEntity does manually for items).
- **No Zod validation** of the merged-and-stamped snapshot.
- ✅ **`deviceId` IS now plumbed** as of Phase 2 step 5 — `/v1/reassign` passes `api:<tokenId>` through to `recordOperation`. `/sync/reassign` and other internal callsites still default to `'server'`. (See `lib/reassignEntity.ts:74-80` and the per-entity `persistXxxMove` functions.)

**Why:** Phase 2 plan explicitly accepted reassign as a thin wrapper "Pre-existing iteration-order bug is out of scope". The fan-out gap was not flagged in the plan but was inherited as "out of scope" by extension. Phase 3 is the planned home for the pipeline rewrite.

**How to apply:** When reviewing /v1/reassign or any change touching `reassignEntity.ts`:
1. Flag if the route docstring claims parity with the rest of the /v1 surface — it doesn't have it (no SSE/push/webhook/GCal fan-out, no Zod validation).
2. If new write paths are added, push to use `applyAndPublishOperation(s)` instead of `recordOperation`.
3. If a webhook subscriber relies on a `*.reassigned` event, point out that today's reassign does NOT fire webhooks at all.
4. The fix is small (call `notifyChanges` after each persist function and route through the apply pipeline). Recommend it on any reassign-touching PR.
