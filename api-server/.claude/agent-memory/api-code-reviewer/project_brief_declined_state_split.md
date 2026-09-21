---
name: brief-declined-state-split
description: The brief feature keeps THREE independent rules over the same itemBrief row (render briefState, selection matchesBriefStateFilter, generation isBriefTarget); adding a BriefState member must be checked against all three
metadata:
  type: project
---

The item-brief feature has **three** separate predicates over the same
`itemBriefInterface` row, and they deliberately disagree:

1. **Render** — `lib/briefSource.ts` `briefState()`. Client-mirrored (logic
   mirrored, comments/type-names intentionally differ — a byte-for-byte `diff`
   of the two files WILL show noise; compare the function bodies, not the file).
2. **Selection** — `lib/itemBriefs.ts` `matchesBriefStateFilter()`. Server-only
   wrapper for `GET /v1/items?briefState=`. Carries a carve-out excluding
   `origin: 'skipped'` from the `none` filter.
3. **Generation** — `lib/brief/briefTargets.ts` `isBriefTarget()`. The ONLY rule
   the server's own three sweeps (batch, sweep-mine, inline hook) read. It is
   hash-mismatch + not-pinned; it never reads `BriefState` at all.

**Why:** a text-less row (`text: null`) is a *recorded decision*, written so the
sweep stops reselecting the item. Render wants to explain it, selection wants to
not re-offer it, generation wants to not redo it — three different answers for
one row. The 2026-09-21 `declined` state addition shifted (1) without shifting
(2) or (3), which is correct precisely because they are separate.

**How to apply:** when a diff adds or changes a `BriefState` member, walk all
three predicates and ask what the new member means in each, and confirm which
one each *caller* actually consumes before accepting a claim like "nothing is
starved". Also note a `declined` model row is NOT a generation target (its hash
matches), so it never re-burns model spend — that is the intended terminal
state, not a bug. Related: [[project_render_rule_vs_selection_rule_split]].
