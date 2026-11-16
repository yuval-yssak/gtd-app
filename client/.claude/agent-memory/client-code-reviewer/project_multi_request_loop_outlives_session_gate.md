---
name: multi-request-loop-outlives-session-gate
description: Turning one gated sync request into a loop (pull paging, drain loops) lets later requests run after the 10s session-gate early release, under a cookie another pass pivoted to a different account.
metadata:
  type: project
---

withSessionGate releases after a hard timeout (10s) while the task keeps running. A single request
issued right after `assertActiveSessionMatches` is safe; a LOOP of requests (pull paging, added
2026-11-16 on feat/pull-paging) keeps sending after the release, and a queued multi-account pass can
`multiSession.setActive` to account B in between. The server then answers as B: B's ops get applied
under A's userId, and B's device row is acked at A's cursor (purge floor corruption).

**Why:** the assert-once-at-start contract was written for one request per gated task.

**How to apply:** for any change that adds more network requests inside a gated sync task, demand a
per-request session re-check (and a forgetNetworkVerificationFor on abort) or a server-side
expected-user guard. Related: [[switch-choice-vs-midpass-pivot]], [[cookie-idb-active-account-drift]].
