---
name: chrome-toggles-enter-focus-restore-surface
description: Collapse/expand chrome buttons inside the wizard root become focus-restore participants; their unmount dumps focus onto the decision primary, arming a review decision
metadata:
  type: feedback
---

Any new button rendered inside `wizardRootRef` that unmounts *itself* on click (collapse/expand
toggles, pin/unpin, show-more) silently joins `useTransitionFocusRestore`'s surface. Clicking it
records it via `focusin`, the click unmounts it, focus falls to `<body>`, and `resolveFocusTarget`
finds no same-testid match — so it falls through to `PRIMARY_ACTION_TEST_IDS` and focuses
`focusKeep` / `clarifySaveNext` / `stageContinue`.

**Why:** the fallback chain was designed for *item/stage transitions*, where landing on the card
primary is the right answer. A cosmetic chrome toggle is not a transition — the user did not move
through the review, so stealing focus onto a button that commits a decision on Enter/Space is worse
than the `<body>` stranding the hook exists to prevent. The hook's own doc comment promises "a user
who parks focus on purpose is never focus-stolen"; self-unmounting toggles break that promise.
Mutually-exclusive toggle pairs need each other registered as partners *before* the bar-primary
fallback.

**How to apply:** when a diff adds a button whose handler flips state that unmounts that same
button, trace it through `resolveFocusTarget` before anything else. Ask: what testid does the
lookup find after the unmount? If the answer is a decision primary, request a partner-pair entry
plus one `toBeFocused` assertion per direction. E2E `.click()` tests never catch this — they assert
visibility, and focus theft is invisible to them.

Resolved shape (accepted 2026-08-25, `PARTNER_CONTROL_TEST_IDS`): do NOT add a second lookup branch
between the exact match and the primaries. Build one ordered candidate list —
`[lostTestId, ...partner, ...PRIMARY_ACTION_TEST_IDS]` — and run a single `.map(byTestId).find(canFocus)`
over it. This keeps the `canFocus` guard uniform across every tier (a *disabled* partner then
correctly falls through to the primaries) and deletes the duplicated null-and-focusable predicate
that separate branches force. Unit tests must include a primary in the lookup so removing the
partner entry fails the test instead of passing vacuously.

Related: [[feedback_focus_restore_clears_record_on_text_fields]],
[[feedback_conditional_render_gate_loses_coverage]].
