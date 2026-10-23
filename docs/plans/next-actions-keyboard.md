# Next Actions — keyboard model experiment

Status: **experiment on `exp/next-actions-keyboard`** (branched from `feat/next-actions-rank` at a3274fd, 2026-10-23); five client-reviewer rounds,
Approved on round 5; round 1 applied (focus never stolen after a focus-leaving cancel, focus restored after downward moves, Enter during a row grab no longer opens
the editor, letters and Done are inert on ghost rows and while Done is in flight, Position buttons disabled while pending, tickler-hidden
rows excluded from the editor's section, the dropped grab's preview order kept until the commit settles); awaiting human review.

Follow-up to [`next-actions-rank.md`](next-actions-rank.md) after the first human test of the reorder feature surfaced three
problems: a keyboard nudge drew the grabbed row on top of its neighbour, there was no way to send a row straight to the
top or bottom of its day, and reaching a row by keyboard took five Tab presses per row.

## Decisions

- **A keyboard grab renders the section in preview order** (`grabPreviewOrder`) instead of shifting rows with transforms:
  the grabbed row really sits at its slot, so virtua keeps it mounted wherever the slot scrolls to, and a long jump works
  in a long list. The pointer drag keeps its transform-based shifts. A moved DOM node loses focus, so the hook gives
  focus back to the element the grab started from (row or handle) after every re-render.
- **Platform-neutral jump chords.** Mac keyboards have no Home/End/PageUp/PageDown. In grab mode Shift+↑/↓ jumps to the
  section edge (Home/End and PageUp/PageDown also work); on an un-grabbed row Alt+Shift+↑/↓ commits the jump at once,
  mirroring Alt+↑/↓. Cmd chords are left to the browser (Cmd+←/→ is history, Cmd+↑/↓ scrolls). Letters never take a
  modifier because ⌥+letter types an accented character on a Mac. Labels are spelled per platform (`platformKeys.ts`:
  ⌥⇧↑ vs Alt+Shift+↑).
- **One tab stop for the list** (`useNextActionsRovingFocus`, the WAI-ARIA listbox pattern): the list container is the
  only tabbable element; it forwards focus to the last-focused row (or the first). ↑/↓ walk rows, Home/End jump to the
  list ends, → enters the row's buttons (←/Esc back), E/D/C/M press Edit/Done/Copy id/Move to, Enter opens the row,
  Space grabs it (MUI's Space-click is suppressed on key up). Rows, handles and buttons are `tabIndex=-1`. A row that
  virtua has unmounted is scrolled into range before it is focused.
- **"Move to…" on desktop too**: the overflow button is no longer touch-only, and a right-click on the handle opens the
  same sheet (touch keeps the long press; contextmenu would fire mid-press there).
- **Position row in the item editor** (`NextActionPositionRow`, under the next-action fields when the SAVED item is a
  next action): Top / Up / Down / Bottom / Move to… within the day the item is saved on, reading the section from the
  visible-accounts list the editor's host already holds and committing through `reorderItem`. The editor's live merge
  adopts the new rank silently (no form field reads it).
- A keyboard legend (the keyboard icon beside the list search) lists every chord for the user's platform.
- **Focus is never stolen.** The grab's refocus runs only when focus is on the body (a moved node dropped it) or still inside the
  row; a grab cancelled by Tab or a click elsewhere leaves focus where the user put it. The grab's window key listener runs in the
  capture phase and stops the event, so the row button (a non-native MUI button) cannot turn the dropping Enter into a click.
- **A dropped grab keeps its preview order rendered** until the commit has refreshed the list, so the row never snaps back to its
  origin (out of virtua's range in a long list) between the drop and the refresh; the commit then gives focus back.

- **Commits wait for the rendered list, not for `refreshItems()`.** That call only starts a transition; the queue's next plan
  must read the rows as they now are, so each commit waits (`waitForRender`, 1 s cap) until the moved row shows at its slot.
  The e2e proves it with the dev harness slowing the items read (`__gtd.setItemsReadDelay`).
- **The editor's Position row flushes the pending text autosave LOCALLY only** before re-keying (never the network push — a
  reorder is an offline write).

## Known limits

- The render barrier gives up after 4 s (`RENDER_SETTLE_TIMEOUT_MS`): a refresh that takes longer (or a concurrent pull that
  makes the planned slot unreachable) ends the wait early — "Moved" is announced, the dropped grab's preview ends (the row
  snaps to the stale order until the refresh lands), and a queued next step plans against the stale rows. While a commit
  waits for its render, a new grab or pointer drag is ignored without feedback.
- Done is guarded by an in-flight set AND an exact-snapshot match against the ghost store (`isGhostOf`: same status and
  `updatedTs`, within the ghost TTL), because `refreshItems()` resolves before the row has left the list. The match is by
  snapshot, not id: a ghost another page recorded for the same item must not block Done on its live row.
  Residual gap (accepted): a remote edit of the same row pulled milliseconds before the Done write, plus a refresh that read
  IDB before the write but landed after it, plus a second D on that re-rendered row, would run Done twice.
- The editor's Position row commits outside the list's serialized commit queue: an inline editor's "Up" racing a list Alt+↓ on
  the same section is not serialized (rare; both re-read IDB, the later write wins).

## Open questions for the review

- Letters on a focused row (E/D/C/M) are convenient but easy to hit by accident; D in particular marks a row done.
- Shift+Tab out of the list stops on the list container once before leaving (a deliberate anti-trap); is that acceptable?
