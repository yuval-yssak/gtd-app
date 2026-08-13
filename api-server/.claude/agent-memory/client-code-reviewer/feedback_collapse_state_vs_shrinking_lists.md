---
name: collapse-state-vs-shrinking-option-lists
description: Local expand/collapse UI state goes stale when the underlying option list is itself dynamically filtered; invariant comments encode the pre-filtering assumption
metadata:
  type: feedback
---

When a component holds local `expanded`/`showAll` state over a list, verify what happens when that
list SHRINKS underneath it from an unrelated cause. Check the affordance (the "show fewer" /
"collapse" control) is still meaningful, not just the content.

**Why:** These components are typically written first against a static list, and the author writes
an invariant comment like "expanded is only reachable via the +N more chip, so a collapse target
always exists". A later feature makes the same list dynamically filtered (faceting, search,
archiving), quietly breaking that invariant. Content stays correct — it's the leftover control that
becomes nonsense — so typecheck, lint and unit tests all stay green and only manual use reveals it.

**How to apply:** On any diff that either (a) adds local expand/collapse state, or (b) makes an
existing option list dynamic, walk the shrink path explicitly: expand the row, then apply a filter
that cuts the list below the collapse threshold. Ask for the affordance to be gated on a predicate
exported from the same module that owns the threshold constants, so the component can't re-derive
and drift. Treat an invariant stated only in a comment as a review target, not as evidence.

Related: [[person-ref-expansion-forgotten]], [[stale-row-snapshot-write-back]]
