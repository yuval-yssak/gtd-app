---
name: removed-symbol-doc-grep
description: On a rename OR a change in when a field is written, grep README.md, CLAUDE.md, docs/, entities.ts docstrings and test comments for the old name/meaning; they stay stale
metadata:
  type: feedback
---

When a change removes or renames an exported helper, the author updates source and test comments but leaves the old name in `api-server/README.md` and `api-server/CLAUDE.md`. Those files are the rule text future authors follow, so a stale name sends them to a function that no longer exists. Seen 2026-10-23 in the next-actions-rank round 2: `hydrateCalendarLinkCarryForward` was replaced by `hydrateItemCarryForwards`, "references updated" was claimed, and README.md:294 + CLAUDE.md:163 still named the old function.

**Why:** the CLAUDE.md pushback rules tell authors which list to add new server-owned fields to, so a wrong name there causes real mistakes later.
**How to apply:** on any removal or rename, run `grep -rn <oldName> api-server/README.md api-server/CLAUDE.md docs CLAUDE.md` before approving, and also check that the rule text still describes the new structure (e.g. a second carry-forward list).

Round 3 follow-up (same day): the doc fix was done by splicing text in, not by rewriting the sentence. The grep came back clean, but README.md:294 ended up with a parenthetical inside a code span (`` `hydrateItemCarryForwards (which also …)` ``) and kept the old file path, and CLAUDE.md:163 had the new sentence and the old one ("goes into that list and its client mirror calendarLinkMerge.ts") side by side, so the two disagreed. A clean grep is necessary but not enough. Read the edited sentence end to end: does it render, does the path point at the new file, and does it still contradict itself?

Same failure for **semantics changes, not just renames** (2026-11-11, device last-seen fix): `/sync/pull` started writing `deviceSyncState.lastSeenTs`, but the interface docstring in `types/entities.ts`, `docs/DATA_MODEL.md` § Device sync state ("most recent operation pushed"), and a test comment ("device still pulls, just doesn't push") all still described the old meaning. When a change alters *when* a field is written, grep the field name across entities.ts docstrings, docs/, and test comments, and re-read each description.
