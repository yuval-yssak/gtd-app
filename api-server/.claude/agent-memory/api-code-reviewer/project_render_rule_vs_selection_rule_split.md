---
name: render-rule-vs-selection-rule-split
description: Client-mirrored pure rules (briefSource.ts) get reused as server-side query filters where they mean something different; keep the selection rule server-only
metadata:
  type: project
---

`lib/briefSource.ts` is mirrored byte-for-byte in `client/src/lib/briefSource.ts`
with a parity fixture table, so it can only ever hold the **render** rule ("what
should the UI show for this row"). The first `/v1` filter built on it
(`GET /v1/items?briefState=`) needed the **selection** rule ("which rows still
need work"), and those differ: a `skipped` brief renders as `none` but must never
be reselected.

Resolved correctly on 2026-09-20 by adding a server-only
`matchesBriefStateFilter` in `lib/itemBriefs.ts` that wraps `briefState()` — the
mirrored module stays untouched, and the filter runs on RAW rows before projection
(the projection drops `origin`, which the selection rule needs).

**Why:** any change to the mirrored module silently invalidates every stored hash
on the other side, so "just add the case to briefState()" is never the fix.

**How to apply:** when a diff reuses a client-mirrored pure predicate as a server
query filter, check whether render and selection semantics actually coincide; if
not, ask for a separate server-only wrapper rather than an edit to the mirror.
Also check the filter runs before the public projection strips the fields it needs.
Related: [[project_mcp_tool_parity_test_names_only]].
