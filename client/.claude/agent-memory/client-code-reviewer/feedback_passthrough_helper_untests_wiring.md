---
name: passthrough-helper-untests-wiring
description: Thin passthrough helpers (runAsOwner-style) get unit-tested while the load-bearing call-site argument stays untested; require a component test that pins the actual arg.
metadata:
  type: feedback
---

When a fix's real behavior is "call site X now passes the *correct* argument" (e.g. pivot to `item.userId` not `account.id`), a pure helper that just forwards that argument and its passthrough unit test do NOT pin the bug — the test passes even if the call site forwards the wrong value.

**Why:** Seen in the multi-account "Clarify with Claude" fix — `runAsOwner(withOwnerSession, item.userId, request)` is a one-line passthrough with unit tests asserting it forwards the userId, but no test asserts the *sheet* passes `item.userId` (the active-account value would still pass every existing test). The bug lived entirely at the call site.

**How to apply:** When reviewing a fix whose essence is "use the right argument at a boundary," flag for a component/integration test that renders the real consumer with a spy and asserts the spy received the owner/correct value (positive) — and ideally a negative pin that it did NOT receive the active-account value. Also consider recommending the thin helper be inlined (lock-step is enforced by the shared argument, not the wrapper). Cross-ref [[retired-scope-negative-pin]], [[inverse-pair-predicates]].

**Resolution (this fix, accepted):** User took the inline-the-helper path — both call sites now call `withOwnerSession(item.userId, () => assist/applyProposal(...))` directly in `ClaudeReviewSheet.tsx` with explicit comments naming `item.userId` as the owner pivot + the 404/403 failure mode. The component wiring test was deliberately skipped: this client's vitest env is `node` with no jsdom/testing-library and zero existing component/AppDataProvider tests (provider uses React 19 `use()`/Suspense + IDB), so a render test means standing up new DOM infra for one argument. The pivot primitive `withAccountSession` is exhaustively unit-tested (pivot+restore, single-account no-op, missing-target warn-no-pivot, throw-restore, concurrent serialization). I accepted this tradeoff — do NOT re-flag the missing wiring test on this surface unless DOM test infra later lands or the call-site argument logic grows beyond a literal `item.userId`.
