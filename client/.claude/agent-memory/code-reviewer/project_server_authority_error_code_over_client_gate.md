---
name: server-authority-error-code-over-client-gate
description: For server-owned eligibility rules (brief scope, reassign scope), the team's validated choice is a named error-code → message branch on the client, not a duplicated client-side status gate
metadata:
  type: feedback
---

When the API gains a rule about WHICH entities an action applies to (e.g. briefs only for open
items, `409 brief_not_applicable`), the accepted client response is: add the code to the API
wrapper's error-code allowlist and add one branch to the `describe*Error` function. Do NOT mirror
the server's status list in the component to pre-disable/hide the button.

**Why:** the server is the authority and the list drifts. The client's copy of the rule would go
stale silently (a status added server-side keeps working; a status removed keeps a dead button
enabled but now with a correct message). The user raised this trade-off explicitly on the
`brief_not_applicable` review (2026-09-21) and chose the message.

**How to apply:** when reviewing a new server refusal code, check three things instead of asking
for a client gate: (1) the code is in the wrapper's allowlist array or it silently narrows to
`undefined` and falls through to the generic line; (2) it is kept OUT of any sibling predicate
that shares its HTTP status — a 409 that is not a pinned/conflict refusal must not trigger the
confirm prompt (`isBriefPinnedError`); (3) the ordering inside `describe*Error`, which branches on
`err.status` first and `err.code` later — a new code sharing 429/503 would be shadowed by the
status branch above it.

Related: [[visible-state-vs-silent-outcome]], [[editor-local-status-outlives-eligibility]]
