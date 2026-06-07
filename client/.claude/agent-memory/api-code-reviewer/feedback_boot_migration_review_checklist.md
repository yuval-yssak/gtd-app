---
name: boot-migration review checklist
description: Recurring patterns to check on api-server boot migrations in loaders/*Migration.ts — bridge-removal deploy safety, two-step array rewrites, and stale operator-name comments
metadata:
  type: feedback
---

Boot migrations live in `api-server/src/loaders/*Migration.ts`, are wired into `mainLoader.loadDataAccess()`, and follow a shared shape (idempotent, boot-only, local `Legacy*Doc` interface for retired field literals). When reviewing one, check:

**1. Bridge-removal deploy safety.** When a migration *replaces* an in-memory compatibility bridge (e.g. `apiTokenScopeMigration` removed the `items.clarify → items.write` backfill in `bearerMiddleware`), the new behavior is only safe because the server doesn't accept traffic until `loadDataAccess()` resolves (per api-server/CLAUDE.md request lifecycle) AND the migration fails-closed (throws → boot aborts → Cloud Run won't route to the crashed container). Confirm both. The risk to flag: any path where an instance on new code could serve a legacy entity *before* its migration completed → would now return 403/wrong result instead of the old bridged behavior.

**2. Two-step array rewrite ordering.** `$addToSet`(new) THEN `$pull`(old) is the correct order for renaming a scope/enum in an array field — at every intermediate point the row holds a *superset* of the final set, so a concurrent auth read can never under-authorize. Flag the reverse order (pull-then-add) as a transient-capability-loss bug. Two concurrent migration runs converge regardless of interleaving.

**Why:** these migrations run on every prod deploy and there is no second review round. A wrong ordering or an unguarded bridge removal is a live-traffic auth/data bug, not a style nit.

**How to apply:** on any new `*Migration.ts`, run this checklist before the verdict. Also watch for stale operator-name comments — see [[as-never-on-mongo-filter-casts]] for the cast smell; separately, docstrings sometimes name an operator the code doesn't use (e.g. a comment claiming `$elemMatch` when the filter is plain `{ field: value }` element-equality). Flag because the comment is the migration's own contract.
