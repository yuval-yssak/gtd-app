---
name: modifier-click-gesture-coverage
description: Modifier-click / new-tab features thread an event through dozens of handlers; the misses are always the surfaces that never had an event param (mobile/touch, programmatic, keyboard) and the blocked-popup + macOS ctrl-is-context-menu edge cases.
metadata:
  type: feedback
---

When a change adds "cmd/ctrl+click opens in a new tab" (or any modifier-gesture branch) to imperative
click handlers, the mechanical `(e) => handler(item, e)` threading is nearly always complete — that
part reviews clean. The defects cluster in four predictable places:

1. **Handlers with no event to thread.** Touch/swipe/tap callbacks, bottom sheets, and programmatic
   opens accept only the entity, so they silently keep the old behaviour. Usually correct on mobile,
   but confirm it is deliberate rather than missed, and that a desktop surface hasn't been left out
   of the same list.
2. **`window.open` returning `null`.** Popup blockers return null and the click becomes a dead no-op
   with no in-tab fallback. This codebase already has the right precedent in
   `openReconsentPopup` (MeetingDetails.tsx): check `if (!popup)` and fall back. New helpers keep
   forgetting it.
3. **macOS ctrl+click is the context-menu gesture, not new-tab.** A `metaKey || ctrlKey` predicate
   fires on macOS ctrl+click, so the browser opens its context menu *and* the app opens a tab. Real
   anchors do not do this. Ask whether ctrl should be gated to non-Apple platforms.
4. **Keyboard activation.** `ListItemButton` / `IconButton` fire `onClick` on Enter/Space with
   `metaKey`/`ctrlKey` false, so keyboard users are unaffected — but if the predicate is ever widened
   to `shiftKey` or `button === 1`, re-check that path.

**Why:** the threading is visible in the diff and reads as the whole change; these four are all
invisible-by-omission. Every one of them degrades to "click does nothing" or "two things happen at
once", which no test staging a happy-path modified click will catch.

**How to apply:** on any diff introducing a modifier-click branch, grep for every call site of the
changed handler signature (not just the ones in the diff) and list the ones still passing no event.
Then check the helper itself for the null-popup fallback and the platform question.

Related: [[feedback_conditional_render_gate_loses_coverage]] — the new-tab branch gets an e2e test
while the plain-click branch it now sits in front of relies entirely on pre-existing coverage.
