---
name: module-use-cache-test-reset
description: Module-level promise caches feeding React use() ship without a test reset; per-version keys then collide across tests and make assertions pass on another test's cached answer.
metadata:
  type: project
---

Hooks that `use()` a module-scoped promise cache (calendar options, item freshness queue reads) keep the cache alive between tests in one file. When the cache key includes a store version that a sibling `_reset...ForTests` puts back to 0, a later test hits an entry an earlier test wrote, for example a `true` "pending" read. Its assertion then passes without the hook re-reading anything.

**Why:** 2026-11-16 lie-fi review. useItemFreshness's `queueReads` Map had no reset. `_resetSyncFreshnessForTests` zeroed the version, so test 4's "unsynced" came from test 3's cached v2 read.

**How to apply:** for each new module cache that a hook reads, check that a `_reset…ForTests` exists and that the test file calls it in afterEach. Also check whether the key can repeat after a reset.
