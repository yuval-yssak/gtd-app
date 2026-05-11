---
name: Bootstrap responses must reflect post-hook state
description: POST/PATCH handlers that fire post-write hooks (item generation, deactivation, side effects) may mutate the persisted state before the response is sent — the response body must reflect the final state, not the pre-hook snapshot
type: feedback
---

Pattern seen in `POST /v1/routines` (2026-05): the handler persists the routine snapshot, returns `presentRoutine(snapshot)` to the caller, and then awaits a post-hook (`ensureFirstRoutineItem`) that may deactivate the routine on `RruleExhaustedError`. Net result: the response body advertises `active: true` while the database holds `active: false`, and the operations log records both a create-active-true and an update-active-false op against the same request.

**Why:** This is bad API hygiene — the most natural client behavior is to read the response and trust it. If a hook can flip state, the caller will be inconsistent until the next pull from the server. Either (a) pre-validate so the hook never fires the state-flipping branch (and 400 if it would), or (b) re-read after the hook and serve the final state.

**How to apply:** When reviewing a POST/PATCH handler that calls a post-write hook (anything that fires AFTER the response payload is assembled), trace whether the hook can mutate the entity. If yes, flag the response-body construction as needing either pre-validation or post-hook re-read. The clearest signal is when the hook contains its own `applyAndPublishOperation`/`updateRoutine`/etc. on the same entityId as the parent handler.
