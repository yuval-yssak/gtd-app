---
name: lww-clamp-must-heal-originating-device
description: Server-side clamping of a field both sides use as the LWW key can't propagate back — RESOLVED via a client-side poisoned-watermark escape, not a protocol flag
metadata:
  type: project
---

Server clamps a client-supplied `updatedTs` down to server `now`. The server row and op log are
healed, but the **originating device is not**: `/sync/pull` is not device-filtered so the clamped
op does come back, and then the client's `applyEntityOp` LWW gate (`existing.updatedTs <=
incoming.updatedTs`) rejects it — the corrected value is by construction *older* than the poisoned
local row. The device stays wedged and loses every inbound edit until wall-clock passes its
watermark.

**Resolution (2026-07-27, shipped):** a client-side escape rather than a protocol flag —
`isPoisonedWatermark(existingUpdatedTs)` in `client/src/db/syncHelpers.ts` treats a LOCAL row more
than `POISONED_WATERMARK_TOLERANCE_MINUTES` (5) ahead of the wall clock as poison and lets any
inbound snapshot win regardless of LWW. Repairs the device from ANY inbound op, no schema/protocol
change. Safe because a genuinely newer edit is never >5min in the future. Server rows poisoned
before the fix are a deliberate follow-up (P4 "sync doctor" sweep); client rows self-heal.

**Why:** LWW is symmetric — both client and server compare on the same key. Any server-side
normalization that moves that key *downward* is structurally unable to win the client's gate.
This is the same shape as [[project_id_normalization_asymmetry_pattern]]: fixing one side of a
compare re-creates the bug from the other direction.

**How to apply:** When reviewing any server-side rewrite of a field used in a LWW/conflict
comparison, ask "how does the originating device learn about the correction?" A plain corrected
op is NOT an answer. Prefer the receiver-side sanity escape (cheap, no protocol change, heals from
any inbound op) over a force-apply flag on the op. Also ask separately for a remediation path for
rows already poisoned before the fix shipped — a write-path-only guard never heals history
(see [[project_remediation_scripts_review_checklist]]).
