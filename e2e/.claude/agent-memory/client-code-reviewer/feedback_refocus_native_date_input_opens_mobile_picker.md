---
name: refocus-native-date-input-opens-mobile-picker
description: Focus-restore fixes that call input.focus() on a native date/time input from a tap handler can pop the iOS picker; Chromium isMobile e2e can't see it
metadata:
  type: feedback
---

When a self-unmounting button (Clear) hands focus back to a native `<input type="date|time">`, the
`inputRef.current?.focus()` runs inside a tap's user gesture. On iOS Safari that is likely to open the
native wheel/popover, and dismissing it may commit a date — undoing the Clear on the very platform the
Clear was built for. The repo's "phone" e2e contexts are Chromium `isMobile`, so they stay green.

**Why:** Raised in the 2026-10-03 DateField/TimeField re-review as a reviewer-requested fix (round-one
"don't drop focus on body") turning into a mobile regression; not device-verified at the time.

**How to apply:** For focus-restore on native pickers, prefer keyboard-only refocus (`event.detail === 0`)
or focusing a sibling button; ask for on-device iOS verification rather than trusting Playwright.
Related: [[focus-restore-records-clear-on-text-fields]].
