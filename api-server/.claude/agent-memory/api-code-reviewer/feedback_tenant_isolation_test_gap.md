---
name: New /v1/ write endpoints consistently ship without tenant-isolation tests on PATCH/DELETE
description: Recurring gap — read-side tenant isolation gets tested in v1References.test.ts, but PATCH/DELETE tenant isolation (user A targets user B's row → 404, no clobber) consistently has no coverage on new write endpoints.
type: feedback
---

When reviewing /v1/* CRUD additions, always check for tenant-isolation tests on PATCH and DELETE. The `findByOwnerAndId` precheck makes the route correct today, but the test gap means a future regression (e.g. someone refactoring to `findById`) is invisible. This was missing on all three new endpoints in Phase 2 step 3 (people, work-contexts, routines).

**Why:** in this codebase the read-side gets tenant isolation coverage via `v1References.test.ts`, but the write side keeps shipping without it because authors assume "if read isolation works, write does too". The two go through different DAO calls.

**How to apply:** for each new PATCH/DELETE on `/v1/*`, request a test in the form: "user A authenticates; insert a row owned by 'bob-user-id'; A PATCHes/DELETEs by id; expect 404; assert bob's row is unchanged and no op was logged for bob." Without this test, mark the change `Changes requested` even when the route logic looks correct.
