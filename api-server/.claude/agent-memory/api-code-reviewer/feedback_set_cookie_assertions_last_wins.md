---
name: set-cookie-assertions-last-wins
description: Tests that read a cookie's Set-Cookie via `.find()` are order-blind — browsers apply the LAST Set-Cookie for a name, so an overwrite after an expiry passes the test
metadata:
  type: feedback
---

When a test asserts on `res.headers.getSetCookie().find(h => h.startsWith(name))`, it reads the FIRST write. Browsers apply Set-Cookie headers in order, so the last one for a name wins. Better Auth after-hooks APPEND to the handler's Set-Cookie list, so a hook that re-issues a cookie the handler just expired produces `[Max-Age=0, Max-Age=604799]` — the `.find()` assertion still sees 0 and passes.

**Why:** 2026-10-14 multi-session cookie renewal review: the "keeps the revoked cookie expired" assertion passed with the hook's not-rewritten guard deleted. Verified by stashing the guard (see [[prove-tests-discriminate-by-stashing-source]]).

**How to apply:** For any cookie-writing hook/test, demand a last-match helper (`findLast`) or an assertion that the name is written exactly once, and a test whose setup actually reaches the guarded branch.
