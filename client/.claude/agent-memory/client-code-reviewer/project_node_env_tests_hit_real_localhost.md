---
name: node-env-tests-hit-real-localhost
description: vitest node env + VITE_API_SERVER=http://localhost:4000 means an unstubbed fetch in a test silently makes a real network call and passes anyway
metadata:
  type: project
---

`client/vitest.config.ts` uses `environment: 'node'` and `client/.env` sets
`VITE_API_SERVER=http://localhost:4000`, so `API_SERVER` is a **real reachable URL** during
unit tests. A test that exercises a code path reaching `fetch` without installing a fetch
stub does not fail — it issues a real request to localhost:4000, which either hits the dev
server or gets connection-refused and is swallowed by the code under test's own
error-to-result mapping.

**Why:** found 2026-09-21 in `reviewBriefSweep.test.ts`. A new `describe('sweepPinnedToOwner')`
block tested the session-pivot branch but had no fetch stub (the stub lived in a *different*
test file). Both tests passed and asserted the right thing about pivoting, while every run
made a live HTTP call. The tell was runtime: **153 ms / 11 ms versus ~1 ms** for sibling
tests in the same file.

**How to apply:** when reviewing a new unit test, trace whether the call under test reaches
`fetch`. If it does and the file/describe has no `vi.spyOn(globalThis, 'fetch')` or
`vi.mock` of the API module, flag it — assert on an injected seam instead. Cheap detection:
run the file with `--reporter=verbose` and look for any test an order of magnitude slower
than its neighbours. Also note `console.log` is suppressed in this suite's default reporter;
force diagnostics through an assertion failure message instead.
