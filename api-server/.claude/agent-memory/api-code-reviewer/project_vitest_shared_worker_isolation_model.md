---
name: vitest-shared-worker-isolation-model
description: The api-server suite reuses worker processes (isolate:false) — what vitest resets per file automatically and the three things it does NOT
metadata:
  type: project
---

The api-server vitest suite runs a two-project split: `isolated` (files containing `vi.mock(`, own process) and `shared` (everything else, `isolate: false`, worker processes reused across files). Isolation per file rests on three legs: a per-file MongoDB database, `vi.resetModules()` in an `afterAll`, and the `isolated` carve-out.

**Verified empirically (probe files in a scratch dir, `--no-file-parallelism`, two files forced onto one worker):**

Vitest DOES auto-restore per file even under `isolate: false`:
- fake timers left on by a previous file (`vi.useFakeTimers()` with no restore) — next file gets real timers
- `vi.stubEnv` / `vi.stubGlobal` values
- module registry, once `vi.resetModules()` runs in `afterAll` (confirmed: a tag monkey-patched onto a DAO singleton in file A is `undefined` in file B, same PID)

Vitest does NOT reset:
- **raw `process.env.X = ...` assignments.** Proven: file A sets `RAW_LEAK`, file B in the same worker reads `fromA`. Only `vi.stubEnv` is scoped. Every test that writes `process.env` directly must restore it in `try/finally` or `afterAll`. Current files all do (`sync.test.ts` deletes `SYNC_CURSOR_HOLDBACK_SECONDS` in `afterAll` *before* `closeDataAccess` deliberately, `calendar.webhooks.test.ts` uses `finally`).

**Why:** reviewing this suite means judging whether a new test file can poison the next one in the same worker. The list above is the actual boundary; don't re-derive it.

**How to apply:** on any new test file in the `shared` project, check for (a) raw `process.env` writes without restore, (b) top-level `await loadDataAccess(...)` — see [[vitest-test-file-id-stamped-in-beforeall]], (c) `vi.mock` in a subdirectory — see [[vitest-mock-detector-blind-spots]].
