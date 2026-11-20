---
name: key-semantics-change-stale-legend
description: Changing what a key does (e.g. Escape now blurs a field first) gets a new legend row but leaves the OTHER KeyboardShortcutsDialog rows and focus-restore comments describing the old one-press behavior.
metadata:
  type: project
---

When a change alters a key's meaning, the author adds a new "Anywhere" row to `KeyboardShortcutsDialog` GROUPS but does not re-read the per-context groups ("In the item editor: Esc — Close") or comments elsewhere that narrate the old flow (`useTransitionFocusRestore` "Escape from the field remounts the card").

**Why:** seen 2026-11-20 on the Escape-steps-out-of-fields change.

**How to apply:** on any keybinding semantics change, grep the key name across GROUPS in KeyboardShortcutsDialog.tsx and across client/src comments, not just the diff. Related: [[default-flip-strands-divergence-comments]].
