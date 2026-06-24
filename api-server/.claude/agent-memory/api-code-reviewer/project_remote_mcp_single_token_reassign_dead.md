---
name: remote-mcp-single-token-reassign-dead
description: gtd_reassign self-resolve on the single-token remote — FIXED 2026-06-24; the client now throws multi_account_unsupported on any non-default account
metadata:
  type: project
---

The remote `/mcp` server reuses the COPIED stdio tools verbatim; `mcp/apiClient.ts` is a single-token variant.

**Historical bug (FIXED 2026-06-24):** the single-token client used to IGNORE `opts.account`/`opts.recipientAccount`, so `gtd_reassign` (which calls `GET /v1/me` with `{account: args.toAccount}` to resolve the recipient) silently resolved `toUserId` to the CALLER → self-reassign no-op.

**Fix (C4):** `createRemoteApiClient.request` now THROWS `GtdApiError(400, {code:'multi_account_unsupported'})` when `opts.account` is a non-`'default'` label (case-insensitive) OR `opts.recipientAccount` is set. Because reassign's FIRST call passes `{account:'work'}`, the guard trips immediately — no self-reassign, no `/v1/reassign` POST. Test: mcpEndpoint.test.ts "fails gtd_reassign explicitly" asserts `isError` + `multi_account_unsupported`.

**How to apply:** when any tool depends on `opts.account`/`recipientAccount` to address a second token, the single-token remote now fails loudly instead of silently self-resolving — verify new multi-account tools trip this guard (and that the guard's `.toLowerCase()` default-label compare still covers the label they pass). Parity test still only compares tool NAMES, so behavior must be asserted separately.
