---
name: default-flip-strands-divergence-comments
description: Flipping a list page's default view (e.g. /waiting-for person->date) leaves stale "divergence from the page default" comments + test names in weekly-review stage code and reviewer memory.
metadata:
  type: project
---

When a route's `useSearch()` default view flips, the derived surfaces that documented their relation to that default go stale silently: `reviewFlowState.ts` stage comments ("DELIBERATE divergence from the page's default"), the matching `reviewFlowState.test.ts` test name, and tracked reviewer memory under `e2e/.claude/agent-memory/`.

**Why:** seen 2026-11-10 on the /waiting-for date-default change — diff touched route, URL parser, specs, but not the review-stage comment that now claims a divergence that no longer exists.

**How to apply:** on any default-view change, grep for "default", "divergence", "person-grouped"/the old view name across client/src, tests, and `*/.claude/agent-memory/`. Also list un-edited e2e specs that `goto` the bare route — the stop hook only reruns edited specs. Related: [[mirror-the-page-ignores-view-toggles]].
