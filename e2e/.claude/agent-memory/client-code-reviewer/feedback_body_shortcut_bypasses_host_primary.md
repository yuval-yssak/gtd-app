---
name: feedback_body_shortcut_bypasses_host_primary
description: A save shortcut wired inside ItemEditorBody calls the body's own onSave, bypassing hosts' renderActions primaries (weekly-review armExplicitSave undo handshake, not-dirty advance).
metadata:
  type: feedback
---

When a keyboard shortcut for "save/primary" is added to a shared editor body, it calls the body's internal save,
not the host's primary button. Hosts that pass `renderActions` (ClarifyStage, FocusStage, RevisitDecisionCard,
ProcessInboxWizard) wrap the save with their own pre-step — e.g. `nav.armExplicitSave(captureUndo(), triggerSave)` —
so the shortcut records a decision with no undo payload, or writes where the host would only advance.

**Why:** 2026-10-23 Cmd/Ctrl+Enter in the item editor; e2e only covered `/item/:id` (no renderActions).

**How to apply:** for any body-level shortcut, grep `renderActions=` hosts and check what their primary does
beyond `api.triggerSave`. Prescribe routing the shortcut through the host (an api hook or a marked primary button).
Related: [[feedback_itemeditorbody_onclose_overloaded_as_decision]], [[feedback_snapshot_undo_ignores_compound_mutations]].
