---
name: trash-status-overloaded
description: Item `trash` means both "user skipped/discarded" and "system retired" (pause, type switch, split, regen); any rule that reads trash as user intent miscounts
metadata:
  type: project
---

`status: 'trash'` on routine items is written by many server paths that are NOT user decisions:
pause (`trashFutureOpenItemsForRoutine`, future open items), type switch (nextAction open item;
calendar future items, which carry `timeStart` but no `expectedBy`), split head, delta regen,
inbound GCal cancellation. Seen 2026-11-11 in the COUNT-exhaustion fix (`hasUsedAllOccurrences`
counted every trash as a consumed occurrence → pause/resume at the last occurrence deactivated
the routine; calendar→nextAction switch counted each trashed future calendar item).

**Why:** no field distinguishes user trash from system trash, so authors assume the user meaning.
**How to apply:** when a new rule reads `trash` (counting, history, analytics, "skipped"), walk every
server trash writer (grep `status: 'trash'` in lib/ + routes/) and ask whether that row should count.
Related: [[project-gcal-series-collision-family]].
