---
name: feedback_lifted_state_loses_key_reset
description: Lifting useState out of a `key={stage.id}`-remounted child into the always-mounted wizard silently drops the remount reset; a stageId tag only hides it until the user returns to that stage.
metadata:
  type: feedback
---

When state that used to live inside a component keyed by `stage.id` (e.g. the ◀ revisit offset in useStageDecisionNavigation) is lifted into WeeklyReviewWizard so a header can read it, the reset the key remount used to give for free is gone. The usual patch — tag the state with its `stageId` and read 0 when it doesn't match — fixes stage A→B but not A→B→A: the stale `{stageId: A, offset: n}` survives and the user re-enters A on an old revisit card. Stale async setters (save-handshake close, undo resolve) captured with stage A also write A-tagged state after a jump.

**Why:** Seen 2026-11-06 in the header-counter-follows-revisit fix; the comment claimed "any stage change lands back on the live queue" and no test jumped away and back.

**How to apply:** For any state lifted out of a keyed child, ask "what reset did the key give?" and demand either an adjust-during-render clear (`if (state && state.stageId !== stage?.id) setState(null)`) or a test doing A→B→A. Related: [[feedback_free_navigation_invalidates_one_way_state]].
