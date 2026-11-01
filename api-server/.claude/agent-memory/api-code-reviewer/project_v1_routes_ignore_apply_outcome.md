---
name: v1-routes-ignore-apply-outcome
description: New /v1 write routes keep calling applyAndPublishOperation (no outcome) and answer 200 with a snapshot that may have been skipped_missing/stale; also multi-row read-plan-write routes lack a per-user lock.
metadata:
  type: project
---

Recurring class seen in the /v1 item routes (complete, trash, and again in the 2026-11-01 `POST /v1/items/:id/move` review): the route builds a snapshot from a row read earlier, writes it through `applyAndPublishOperation`, and returns the snapshot as success without checking the apply outcome. Only PATCH uses `applyAndPublishOperationWithOutcome` + `strict` (after the 2026-09-27 duplicate-calendar-item incident).

A second pattern from the same review: a server-side port of a client planner rebuilt the row snapshots with `flatMap(... ? [x] : [])`, so a row that left the section between two reads was dropped without any error, and the route still answered 200.

**Why:** a row deleted or re-statused between the read and the write produces a quarantined or stale op, but the caller (often an MCP agent) is told it worked.

**How to apply:** on any new /v1 mutation route, check that it uses the WithOutcome variant and maps non-`applied` outcomes to 409. On multi-row read-plan-write flows (re-keys, cascades), look for a per-user `KeyedMutex` (`lib/keyedMutex.ts`), because MCP clients issue parallel tool calls. Also check that a missing row throws or returns 409 rather than being filtered out. Once a stop-at-first-failure loop is in place, check what a partly written plan leaves behind. A run re-key that stops halfway can swap unranked rows, because a ranked row sorts below an unranked one, and a stopped whole-section rebalance mixes origin keys with old keys. The move review (round 2) accepted this as rare. Related: [[op-cursor-ordering-invariants]].
