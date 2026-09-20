---
name: hono-subrouter-catchall-expands-to-mount
description: A Hono sub-router's .use('*') expands to the whole mount prefix (/v1/*), so a router mounted FIRST runs its auth middleware for every sibling /v1 path — 401'ing browser preflights before cors() can answer
metadata:
  type: project
---

`new Hono().use('*', authX)` inside a sub-router that is later `.route('/v1', sub)`-mounted does
NOT scope `authX` to that router's own paths — it expands to `/v1/*` and runs for **every** `/v1`
request. Whether that is harmful depends entirely on mount order in `index.ts`: a router mounted
FIRST pre-empts every sibling, including `OPTIONS` preflights, which get a 401 with no CORS headers
(`net::ERR_FAILED` in the browser, invisible server-side).

Hit for real: `routes/v1/claude.ts` used `.use('*')` and is mounted first, so it 401'd the browser
preflight for the new `OPTIONS /v1/items/:id/brief/generate` (item-brief Phase 2, 2026-09-20).
Fixed by scoping to `.use('/claude/*', …)`. Verify the scoped pattern still covers 100% of the
router's own routes — if any route sits outside the prefix it silently loses its auth middleware.

`routes/v1/{items,me,people,operations,reassign,routines,workContexts}.ts` STILL use `.use('*')`.
They are currently harmless only because they are mounted AFTER the cookie-authed exception routers
and after `publicCors()`. Any new router mounted before them, or a reordering of `index.ts`,
re-arms the same trap.

**Why:** the bug is invisible in unit tests that mount one sub-router alone — the expansion only
bites when several routers share the `/v1` base in the real order.

**How to apply:** on any diff that adds a `/v1` router or reorders `index.ts` mounts, (1) grep for
`.use('*'` in every `/v1` sub-router, (2) require a CORS/preflight regression test that builds the
app with the REAL `index.ts` mount order (see the `buildRealV1App` helper in `cors.test.ts`) rather
than an isolated router, and (3) confirm the test is non-vacuous by reverting the scoping and
watching it fail. A preflight assertion against a single-router app proves nothing.
