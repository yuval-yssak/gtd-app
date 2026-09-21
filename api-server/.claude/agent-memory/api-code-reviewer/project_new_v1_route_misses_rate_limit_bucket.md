---
name: new-v1-route-misses-rate-limit-bucket
description: New /v1 routes are repeatedly added without an arm in classifyRequest, silently shipping unrate-limited write endpoints; check the bucket on every new /v1 route
metadata:
  type: project
---

Every new `/v1/*` route so far has shipped without its arm in `classifyRequest`
(`auth/rateLimitMiddleware.ts`). `classifyRequest` returns `null` for unmatched
method+path and the middleware then calls `next()` — i.e. **no limiter at all**,
not a fallback bucket. Confirmed unrate-limited so far: `POST /v1/items/:id/trash`
and `PUT /v1/items/:id/brief`. The `PUT` method is not matched by any arm at all.

**Why:** the classifier is a hand-maintained literal/regex list decoupled from the
Hono route table, so nothing fails when they drift. `docs/PUBLIC_API.md` compounds
it by describing the write bucket as "All POST / PATCH / DELETE under /v1/*",
which is both wrong (it is an allowlist, not a method rule) and now incomplete
(PUT exists).

**How to apply:** on any diff that adds a `/v1` route, grep `classifyRequest` for
the new path and flag its absence as a Critical/Standards issue. Also check that
`docs/PUBLIC_API.md`'s rate-limit table still describes reality. Related:
[[project_public_api_writes_bypass_gcal_invariants]].
