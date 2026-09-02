---
name: server-protocol-change-leaves-client-tests-lying
description: An api-server sync-contract change lands with a comment-only client diff; the client's unit tests still mock and assert the retired contract, so the suite greens against a protocol the server no longer speaks.
metadata:
  type: feedback
---

When a change is scoped as "api-server only, plus one client comment", the client's mock-driven
tests are the blind spot. The client mocks `#api/syncClient`, so every test supplies the response
shape *by hand* — a server that changes what it sends cannot break them. They keep asserting the
old contract and keep passing.

**Why:** In the op-ts-insertion-stamp review, `/sync/bootstrap` stopped sending `serverId: MAX_OP_ID`
and started sending `''`. Three client tests still mocked `serverId: MAX_OP_ID`, one of them
asserting `expect(cursor?.lastSyncedId).toBe(MAX_OP_ID)` with a comment explaining the behavior the
change had just abandoned. Meanwhile the newly load-bearing property (`''` survives to IDB, is not
coerced) had zero coverage. Same pass: the updated client comment claimed "old servers omit
serverId" when the payload type marks it required and old servers sent it explicitly — the `??`
fallback it justified was unreachable, and its fallback *value* had become the wrong sentinel.

**How to apply:** On any review whose diff is mostly server-side with a token client edit:
1. Grep the client tests for the literal old values (sentinels, enum members, magic strings) the
   server stopped sending. Each hit is a test that is now lying — demand it be re-pinned to the new
   contract, not just left green.
2. Ask what property became load-bearing *because of* the change, and check whether anything pins
   it. New guarantees ship untested far more often than old ones break.
3. Read `?? FALLBACK` / `|| FALLBACK` defaults against the payload's TypeScript type. If the field
   is required, the fallback is dead code and its comment is almost certainly fabricating a
   "legacy server" that never existed. Worse, a fallback that was correct under the old contract
   can be actively wrong under the new one.
4. Verify empty-string preservation explicitly when a sentinel becomes `''`. `??` is safe, `||` is
   not — trace every hop (read helper, write helper, URLSearchParams round-trip).

Related: [[feedback-forward-only-guard-vs-server-holdback]]
