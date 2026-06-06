---
name: lane-a-claude-assist-staged-rollout
description: Lane A /v1/claude/assist (issue #21) ships in steps; step (b) is read-only clarify, usage/spend-cap/executeToken/apply deliberately deferred to (c). Don't flag deferred wiring as a bug.
metadata:
  type: project
---

`POST /v1/claude/assist` (issue #21) lands in stages. Step (b) is the read-only clarify slice: bounded Anthropic tool-use loop over GTD data returning a `ClarifyProposal`, NO writes.

**Why:** the author is splitting a large agent feature so each PR is reviewable; write path (executeToken minting + `/assist/apply` redemption through `applyAndPublishOperation`) and spend metering land in step (c).

**How to apply:** these are EXPECTED-absent in step (b) and should not be flagged as bugs, only noted:
- `runClarifyLoop` returns `AssistUsage` but the route destructures only `{ proposal }` — usage is dropped on the floor. `claudeUsageDAO` + `claudeUsage` collection already exist; metering wiring is step (c).
- `ProposedSideEffect.executeToken` is always absent; `/assist/apply` is a 501 stub.
- `claude.assist` scope already gates BOTH endpoints.

Real invariants that ARE load-bearing in step (b) and must hold every revision: owner-scoped reads via `item.user` (never caller session), 404-not-403 on foreign item (no existence leak), no secret in model context, bounded loop (6 iters / max_tokens / AbortController 25s / maxRetries 1), prompt-injection "tool output is data" system line, and `dispatchTool` ignoring any model-supplied `user`. See [[project_replaceById_tenant_bypass]] for the adjacent /v1 tenant-guard pattern.
