---
name: secondary-editor-action-own-transition
description: A new destructive action added to an editor body (Pause, Archive) runs in its own useTransition, so the editor's Save/Cancel stay enabled mid-write; also `db.get(...) ?? prop` fallbacks resurrect remote deletes.
metadata:
  type: feedback
---

When an editor body gains a second write gesture as a child component (e.g. RoutinePauseAction
inside RoutineEditorBody, 2026-11-06), the child owns its own `useTransition`. The body's Save
disables on `isSaving` only, so Save can run concurrently, read a stale liveRoutineRef
(active:true) and overwrite the pause. The child usually also re-reads IDB with
`(await db.get(store, id)) ?? propRow` — the fallback re-puts a row a remote device deleted.

**Why:** both are invisible in e2e (the race window is the trash cascade; remote delete during an
open confirm dialog is never seeded), and the project already fixed editor resurrection once.

**How to apply:** for any added editor action, check (1) every other write button is disabled by
the action's pending state (simplest: run it through the body's startSaving), (2) the IDB re-read
bails on a missing row instead of falling back to the prop. Related: [[confirm-gate-stale-snapshot]].
