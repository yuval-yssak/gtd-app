---
name: removed-symbol-doc-grep
description: When a fix round claims "references updated" after removing/renaming a function, grep README.md + api-server/CLAUDE.md for the old name — source/test refs get updated, guidance docs don't
metadata:
  type: feedback
---

When a change removes or renames an exported helper, the author updates source and test comments but leaves the old name in `api-server/README.md` and `api-server/CLAUDE.md`. Those files are the rule text future authors follow, so a stale name sends them to a function that no longer exists. Seen 2026-10-23 in the next-actions-rank round 2: `hydrateCalendarLinkCarryForward` was replaced by `hydrateItemCarryForwards`, "references updated" was claimed, and README.md:294 + CLAUDE.md:163 still named the old function.

**Why:** the CLAUDE.md pushback rules tell authors which list to add new server-owned fields to, so a wrong name there causes real mistakes later.
**How to apply:** on any removal or rename, run `grep -rn <oldName> api-server/README.md api-server/CLAUDE.md docs CLAUDE.md` before approving, and also check that the rule text still describes the new structure (e.g. a second carry-forward list).

Round 3 follow-up (same day): the doc fix was done by splicing text in, not by rewriting the sentence. The grep came back clean, but README.md:294 ended up with a parenthetical inside a code span (`` `hydrateItemCarryForwards (which also …)` ``) and kept the old file path, and CLAUDE.md:163 had the new sentence and the old one ("goes into that list and its client mirror calendarLinkMerge.ts") side by side, so the two disagreed. A clean grep is necessary but not enough. Read the edited sentence end to end: does it render, does the path point at the new file, and does it still contradict itself?
