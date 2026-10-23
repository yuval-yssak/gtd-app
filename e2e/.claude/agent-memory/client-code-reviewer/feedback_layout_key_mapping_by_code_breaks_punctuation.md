---
name: feedback-layout-key-mapping-by-code-breaks-punctuation
description: Shortcut key normalizers that map letter KEYS by event.code send AZERTY/Dvorak punctuation (`?`, `,`) to the wrong letter; unit tests only cover US/Hebrew
metadata:
  type: feedback
---

A "layout-independent" shortcut mapper (`shortcutKeyOf`, exp/keyboard-regions, 2026-10-23) put the `KeyX → letter` code fallback ahead of "printable ASCII as typed" so Hebrew `g w` (W types `'`) works. Side effect, probed: French AZERTY `?` (Shift+KeyM) → `m`, so the legend key is dead; Dvorak `,` (KeyW) → `w`, so `g ,` jumps to Waiting For instead of Settings.

**Why:** the unit tests enumerated only US, German Shift+7 and Hebrew — every Latin layout that moves punctuation onto a US letter position was untested.
**How to apply:** for any key normalizer touching `event.code`, demand cases for AZERTY (`?`/`,` on KeyM), Dvorak (`,` `.` `'` on KeyW/KeyE/KeyQ) and AltGr layouts. Workable rule: the typed character wins when it is itself a bound shortcut char; otherwise fall back to the code letter.

Round 3 adopted the "typed shortcut char wins, else code letter" rule — approved. Residuals worth re-checking if the normalizer changes again: any letter-key punctuation still maps to its US letter (Colemak `;` on KeyP → `p`, so `g ;` = People), and Windows AltGr chords arrive with ctrlKey+altKey both true, so AltGr-typed `/ ? ,` (Brazilian ABNT laptops) are blocked by the modifier guard.
