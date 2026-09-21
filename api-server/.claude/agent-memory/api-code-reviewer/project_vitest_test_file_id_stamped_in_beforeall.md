---
name: vitest-test-file-id-stamped-in-beforeall
description: TEST_FILE_ID (per-file DB namespacing) is stamped in a setup.ts beforeAll — at module-eval time it still holds the PREVIOUS file's value, so top-level loadDataAccess collides
metadata:
  type: project
---

`src/tests/setup.ts` stamps `process.env.TEST_FILE_ID` (sha1 prefix of the test path) in a `beforeAll`; `mainLoader.namespaceTestDB` reads it to build `gtd_test_<name>_p<ppid>_w<pool>_f<fileId>`.

**The hole:** `beforeAll` runs after the test file's module body. At module-evaluation time `TEST_FILE_ID` holds whatever the *previous* file on that worker left there (or is unset for the first file). Verified with probes: a file doing top-level `await loadDataAccess('gtd_test_probe')` got `..._f0` for the first file and the **previous file's hash** for the second — i.e. two files silently sharing one database, which is exactly what the per-file namespacing exists to prevent.

No current test file does this — every one calls `loadDataAccess` inside `beforeAll`. The invariant is undocumented and unenforced.

**Why:** the failure is silent and non-local — it presents as a flaky cross-file data collision in some *other* file, long after the offending top-level await was added.

**How to apply:** when reviewing a new/changed api-server test file, grep for a top-level `await loadDataAccess` (or any top-level `await` that touches `db`). Require it be moved into `beforeAll`. A cheap hardening the codebase could adopt: have `namespaceTestDB` throw under `NODE_ENV=test` when `TEST_FILE_ID` is unset, instead of falling back to `'0'`. Related: [[vitest-shared-worker-isolation-model]].
