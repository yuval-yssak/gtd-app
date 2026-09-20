---
name: uncommitted-text-vs-server-ai-call
description: Server-side AI buttons (assist, generate brief) fire before the editor's 800ms debounced notes/title autosave has flushed, so the model reads stale text
metadata:
  type: project
---

Any in-editor button that asks the SERVER to read the item's title/notes (Claude assist, "Generate
brief") races the editor's own text autosave. `useAutosave` debounces 800ms, and the queued sync op
still has to reach the server after that. Only the Title field flushes on blur
(`textAutosave.flush()`); `NotesSection`'s `onBlurOutside` merely leaves editing mode and does NOT
flush. So a user who types notes and immediately clicks the AI button gets a result computed from
the previous notes — or a `skipped`/short-notes verdict on a long note — stamped with the OLD
`sourceHash`, which then reads as stale/`none` and can suppress later sweeps.

**Why:** the brief feature made this visible: the generate endpoint recomputes `sourceHash`
server-side from the server's copy of the item, so any client/server text divergence is silently
baked into the stored row rather than erroring.

**How to apply:** when reviewing a new server-side AI action in the item editor, check that the
handler awaits the text autosave flush AND the sync push (`waitForPendingFlush`) before the fetch.
The e2e specs for these features tend to seed notes via the `gtd.*` harness + `gtd.flush` and never
navigate, so they structurally cannot catch it — ask for a test that types in the editor.

Related: [[no-dom-hook-test-gap]], [[live-merge-reset-drops-burst-baseline]]
