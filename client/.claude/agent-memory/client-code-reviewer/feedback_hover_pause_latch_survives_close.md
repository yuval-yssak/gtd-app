---
name: hover-pause-latch-survives-close
description: Hand-rolled hover/focus "pause" state (toast timers) is not reset when the element unmounts on close; the next open never auto-dismisses. Also: a legacy-key fallback that a bridge writes back to pins "system" users.
metadata:
  type: feedback
---

A component that stays mounted while `open` toggles, but tracks pointer/focus-inside in refs + state, latches
`isPaused = true` when the user clicks a button inside it: the element unmounts under the pointer, so no
pointerleave/blur ever arrives. The next `open` starts paused and never times out. Found in the DS `Toast`
(2026-10-24, proven with a throwaway jsdom test: pointerEnter → open=false → open=true → no timeout after 60s).

**Why:** existing tests only cover enter → leave on one open cycle, so they stay green.

**How to apply:** for any pause/hover/focus latch, ask "what resets it when the content unmounts?" The fix is
to scope the hook to an inner component rendered only while open (or reset on `open` change). Ask for a test
that closes while hovered/focused and reopens.

Related trap in the same review: `lib/colorScheme.ts` falls back to MUI's `mui-mode` key, and the transitional
`MuiColorSchemeBridge` calls MUI `setMode(resolved)`, which persists the RESOLVED scheme to `mui-mode`. Any user
without the new key gets pinned from "system" to a fixed scheme on the next load. When a migration reads a
legacy key, check whether anything still writes it. See [[humanize-enum-via-existing-label-map]] for another
"existing store reused" pattern.
