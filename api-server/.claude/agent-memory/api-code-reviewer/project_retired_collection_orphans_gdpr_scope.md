---
name: retired-collection-orphans-gdpr-scope
description: Removing a feature's DAO + its userDataInventory entry leaves the live Mongo collection's per-user rows outside account deletion; the inventory test only enumerates DAO files so it stays green
metadata:
  type: project
---

When a feature is removed, the author tends to delete the DAO, the `USER_DATA_COLLECTIONS` entry and the fixture together (first seen 2026-10-22 with `claudeUsage` on the Lane A removal). The completeness test enumerates `src/dataAccess/*DAO.ts`, so it passes. But the collection still exists in staging/prod with per-user rows, and `DELETE /auth/me` no longer touches them. That breaks the deletion promise in the privacy policy.

**Why:** the inventory is code-driven, but data in Mongo outlives the code. Nothing in CI sees the deployed collections.

**How to apply:** on any change that drops a DAO, require one of two things. (a) Keep the inventory entry and fixture (deletion-only or `omitted` export) until the collection is dropped. (b) Ship a convergent drop: check `listCollections`, then `drop` — see [[boot-migration-not-convergent]]. An operator-run mongosh drop on staging and prod is also fine, but it must be recorded as a deploy step.
