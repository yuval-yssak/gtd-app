---
name: project-brief-copy-auto-write-closed-items
description: New brief UI copy ("written automatically", "regenerate to unpin") keeps ignoring that done/trash items are never briefed (server 409); check status gating on every new brief string.
metadata:
  type: project
---

Brief UI strings that promise the sweep will write/refresh a brief, or tell the user to regenerate, are only true for open items (`isBriefableItemStatus`). The empty-hint already splits on it (`BRIEF_EMPTY_HINT` vs `BRIEF_EMPTY_CLOSED_HINT`), but new copy (2026-11-20 Stale-chip tooltip in `describeBriefLabels`) was written from (item title/notes, row) alone and promised "A new one is written automatically" on done/trashed items.

**Why:** pure describe* helpers get a narrow Pick of the item that omits `status`, so the closed-item branch is structurally invisible to the author.

**How to apply:** when a review adds or edits any brief-facing string, check whether its input includes status/isBriefable and whether a done/trash fixture is tested. Related: [[project-new-lib-module-ships-untested]].
