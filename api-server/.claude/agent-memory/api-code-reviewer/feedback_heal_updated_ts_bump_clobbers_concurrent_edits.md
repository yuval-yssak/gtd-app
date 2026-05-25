---
name: heal-updated-ts-bump-clobbers-concurrent-edits
description: Server-side "heal" writes that bump updatedTs for plumbing-only changes (link re-stamps, etc.) can silently drop concurrent client edits via the LWW guard in applyEntityOp.
metadata:
  type: feedback
---

Server-internal "heal" writes (e.g. `tryHealStaleLink` in `calendarPushback.ts`) that rewrite plumbing-only fields (`calendarIntegrationId`, `calendarSyncConfigId`) and stamp `updatedTs: now` have a subtle LWW interaction: any concurrent offline client edit with `snapshot.updatedTs < T_heal` will be silently rejected by `applyEntityOp` (the LWW guard is `existing.updatedTs <= snapshot.updatedTs`). The healed snapshot is also broadcast as an op with `T_heal`, so other devices replicate the same drop client-side.

**Why:** the existing precedent for server-internal stamping is `stampItemLastPushed` — it explicitly omits `updatedTs` to avoid corrupting the LWW anchor. Any new server-managed write that bumps `updatedTs` widens the window where offline edits can be lost. The narrower the scope of the heal (link plumbing only, no user-visible field), the more this trade-off matters: the heal *itself* will retry next pushback if dropped, but the *user's* edit won't.

**How to apply:**
- On any new server-side write that mutates server-managed fields (link ids, sync cursors, echo markers, healed references) AND records an op for cross-device convergence, ask: "does this need to bump updatedTs?" If the fields are server-internal and not user-edit-visible, prefer the `stampItemLastPushed` pattern: preserve `existing.updatedTs`, write the op anyway with the unchanged timestamp.
- Trade-off: a heal that doesn't bump updatedTs converges on devices whose `existing.updatedTs == snapshot.updatedTs` (replace fires on `<=`), and is rejected by devices with newer local writes. That's actually correct: don't clobber.
- When the heal MUST bump updatedTs (e.g. because the field IS user-visible and concurrent edits are semantically incompatible), document the trade-off and add a regression test asserting the offline-edit-loses-to-heal behavior is intentional.
- Verify on review by tracing: heal write → recorded op → another device's `applyEntityOp` → does the heal's bumped `updatedTs` exceed plausible offline-edit timestamps? In practice, "yes" for any offline window longer than the time between server pushback and client reconnect.
