---
name: GCal pushback error handling must not silently diverge DB from GCal
description: Pattern-level feedback — when a pushback helper catches+logs a GCal error, always check whether the DB is now ahead of GCal in a way that later flows don't reconcile
type: feedback
---

Calendar pushback helpers in this codebase follow a fire-and-forget pattern: errors from the GCal provider are logged via `console.error` and swallowed so the push response to the client doesn't fail. This is intentional, but when reviewing new pushback code, verify both sides of the split-brain state that a swallowed error creates:

1. *Is the DB mutation ordered before or after the GCal mutation?* In this codebase the convention is DB-first: the sync push commits locally, then pushback runs. A GCal failure therefore leaves DB ahead of GCal.
2. *Does some later flow reconcile?* For recurring series in particular, check whether the next webhook-driven inbound sync would either (a) re-apply the missed mutation, (b) be idempotent with respect to it, or (c) silently diverge forever until the user triggers a manual action.

**Why:** Case (c) is the bug class — e.g. a pause that trashes items locally but fails to cap the GCal master will look "done" to the user while GCal keeps producing occurrences. Items arriving back via pull are often filtered out (routineEventIds set, echo window, etc.), so no alarm fires. The inconsistency only surfaces on a later resume or routine edit when it may be harder to debug.

**How to apply:** In reviews of any new pushback branch, ask: "If the GCal call throws, what does the DB look like, and what closes the loop?" Acceptable answers are "the next resume/update overwrites GCal with the current state" (like `pushExistingRoutineToGCal` does) or "the change is append-only and GCal will catch up via retry". Unacceptable: "we'll rely on the user noticing." Require either a retry mechanism, a surfaced error, or a documented reconciliation path in a comment.
