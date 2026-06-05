---
name: test-db-ppid-isolation
description: api-server test DBs are namespaced by process.ppid under NODE_ENV=test to survive concurrent npm-test runs; globalTeardown drops them
metadata:
  type: project
---

The api-server vitest suite shares a single local Mongo (`mongodb://127.0.0.1:27017`) and was flaky when two `npm run test` processes ran concurrently (stop-hook parallel check + a manual run) — beforeEach cleanup in one run wiped the other's data. `fileParallelism: false` only serializes within one run.

Fix (uncommitted, branch gtd-main): `mainLoader.namespaceTestDB(name)` appends `_p${process.ppid}` when `NODE_ENV === 'test'`; `src/tests/globalSetup`-as-teardown drops every `*_p${process.pid}` DB at run end. Empirically: vitest globalSetup runs in the parent process whose `pid` == workers' `ppid`, and the returned fn runs as teardown in that same process — so the suffixes line up.

**Why:** removes cross-process collision on `gtd_test*` databases.

**How to apply:**
- Gating is purely `NODE_ENV === 'test'`, which is true under ANY vitest run — including the separate `vitest.sync-audit.config.ts` suite, which has NO globalTeardown. So the audit suite now leaks `gtd_test_sync_audit_p<pid>` DBs (its cleanup is GCal-event-keyed, not DB-name-keyed). Flag this when reviewing changes that touch namespaceTestDB or the audit config.
- dotenv does NOT override a preset env var, so `.env` having `NODE_ENV=development` does not clobber vitest's `NODE_ENV=test`. Verified empirically.
- Crash-before-teardown leaks namespaced DBs; acceptable because the cluster is the developer's LOCAL mongo, not shared infra. `endsWith('_p<pid>')` collision risk is ~nil (real DBs are gtd_dev/gtd_test/admin/config/local).
