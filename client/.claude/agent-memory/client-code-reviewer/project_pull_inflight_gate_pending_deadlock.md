---
name: pull-inflight-gate-pending-deadlock
description: pullInFlight entries registered before the session gate is acquired make the orchestrator's pullFromServerUnguarded join a gate-blocked promise and stall the full gate timeout (10s)
metadata:
  type: project
---

`pullFromServer` registers its promise in `pullInFlight` BEFORE `withSessionGate` grants the gate. If the orchestrator (`syncAllLoggedInUsers`, gate holder) then calls `pullFromServerUnguarded` for that user, it returns the gate-pending promise and waits on the gate it holds — released only by the gate's hard timeout (10s, warns "session gate task exceeded"). Pre-existing hazard (noted in e2e/reassign.spec.ts reloadInbox comment); any change that creates NEW gated pulls at gate hand-off time (e.g. 2026-11-16 fix/mcp-move-item-flake "follow-up pull after a reading pull") widens it — confirmed by a probe test: orchestrator queued behind a reading SSE pull + one mid-read SSE request → 1502ms stall at a 1500ms gate timeout.

**Why:** the dedupe map conflates "queued for the gate" with "running"; the unguarded path can't tell them apart.

**How to apply:** on any diff touching pullFromServer/pullInFlight/withSessionGate, check whether a gated pull can be registered while the orchestrator is queued or running, and ask for a test that runs `withSessionGate(() => pullFromServerUnguarded(...))` against it with a short `setSessionGateTimeoutMs`. Related: [[deferred-requeue-ref-guard-staleness]].

Update 2026-11-16 (same branch, re-review): fixed by splitting per-user state into `queued` (waiting for the gate, joined only by pullFromServer) and `running` (joined by both). Residual edge to watch: a queued gated pull that enters the gate via the gate's hard timeout while the orchestrator's unguarded pull for the same user is still `running` starts a second concurrent doPull (harm bounded by forward-only cursor + apply lock).
