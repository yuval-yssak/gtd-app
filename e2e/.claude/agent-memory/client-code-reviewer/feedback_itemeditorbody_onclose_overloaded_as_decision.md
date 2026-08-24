---
name: itemeditorbody-onclose-overloaded-as-decision
description: Wizards that treat ItemEditorBody's onClose as "the item was decided" also make Escape/abort count as a decision, because onClose has three distinct callers
metadata:
  type: feedback
---

`ItemEditorBody`'s `onClose` prop is invoked from three unrelated situations:
1. post-save (`commitSave` / `commitClarifyToRoutine` → `closeEditor()`)
2. `usePageEscapeToClose` when `chrome === 'page'` — deliberately the RAW `onClose`, not `closeEditor`
3. the `reassignInFlight` short-circuit branch (`ReassignInFlightInline onClose={closeEditor}`)

Host wizards keep re-adopting the ProcessInboxWizard trick of passing "advance the queue" as
`onClose` so Save-and-next is free. That is safe for ProcessInboxWizard because its queue is a
monotonic index and skipping forward is the same gesture as aborting. It is NOT safe for queues
where advancing is a semantically meaningful *decision* (a processed counter, an
item-leaves-the-queue-for-good rule) — Escape then silently marks the item reviewed, and the
`renderActions` Skip button is not even rendered in the reassign-in-flight branch.

**Why:** `onClose` conflates "editor is going away" with "user committed"; only case 1 means
committed.

**How to apply:** on any new host of `ItemEditorBody`, check what `onClose` is wired to and ask
what Escape does under `chrome="page"` and what the reassign-in-flight branch does. If the answer
differs from the Save path, the host needs to distinguish them — e.g. set a "saved" flag in
`onSaved` and have `onClose` consult it. See [[project-multi-chrome-editor-pattern]] and
[[project-editor-close-gestures-bypass-guard]].
