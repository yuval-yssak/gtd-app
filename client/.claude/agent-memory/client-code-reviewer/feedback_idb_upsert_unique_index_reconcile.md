---
name: idb-upsert-unique-index-reconcile
description: IDB stores keyed by id but with a unique secondary index need delete-stale-then-put reconciliation; watch the dangling activeAccount pointer and concurrent Promise.all callers.
metadata:
  type: feedback
---

When reviewing IDB upsert helpers on a store keyed by primary key but carrying a UNIQUE secondary index (e.g. `accounts` keyed by `id`, unique `email`), a plain `db.put` throws `ConstraintError` whenever the indexed value already exists under a different primary key. The correct fix is a single readwrite transaction: index-get the stale row, delete it if its key differs, then put.

**Why:** The `accounts` store hit exactly this — re-login mapped one email to a new Better Auth userId, ConstraintError surfaced as "Something went wrong" on /auth/callback. Pattern recurs anytime identity can drift across the unique-indexed column.

**How to apply:** On any such helper, verify three things, in priority order:
1. Atomicity + tx-liveness — delete and put MUST be in the same `readwrite` tx, and every `await` between `db.transaction(...)` and `tx.done` must be on an IDB request (no dayjs/fetch/bare microtask), or idb auto-commits the tx early.
2. Dangling pointer to the reconciled-away primary key — a separate singleton store (e.g. `activeAccount.userId`) may still point at the just-deleted id. Check whether the caller re-points it (the re-login callback path does via setActiveAccount; the multi-session seed paths do NOT). Recommend keeping the upsert single-responsibility and pinning the behavior with a test rather than baking activeAccount cleanup into the upsert.
3. Concurrent callers — these helpers are often invoked via `Promise.all(sessions.map(upsert))`. The blind-put version was order-independent; the read-modify-write version relies on IndexedDB serializing overlapping readwrite txns on the same store. Safe for distinct keys; non-deterministic (but not corrupting) only if the input list itself contains duplicate indexed values.
