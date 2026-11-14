---
name: history-counter-counts-gesture-rows
description: Rules that derive routine state from its item history (done/trash counts) also count rows other gestures mint — type-switch trash, pause trash, calendar-phase rows
metadata:
  type: project
---

A routine rule computed from the routine's done/trash items (e.g. the COUNT-exhaustion rule from 2026-11-11, fix/routine-count-exhaustion) gets reviewed against the disposal path only. Other gestures also write `trash` rows with the same `routineId`. A calendar→nextAction type switch trashes every future calendar item, and those rows carry no `expectedBy`. The pause gesture trashes the open item.

The first version counted those rows as "skipped occurrences". Switching a calendar `COUNT=3` routine to nextAction deactivated it right away with no item. I confirmed this with a scratch test: it fails with the fix and passes on main.

**Why:** a gesture's bulk trash has the same shape as a user skip, and the unit tests seed only clean done/nextAction histories.

**How to apply:** when a change reads routine item history, list every writer of `status: 'trash'` with that routineId (trashNativeItemsForTypeSwitch, pause, removeRoutine, the exhausted-schedule trash) and check each against the rule. Ask for a test per writer. Related: [[routine-open-item-lock-coverage]].
