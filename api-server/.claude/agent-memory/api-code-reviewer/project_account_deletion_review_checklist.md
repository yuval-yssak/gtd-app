---
name: account-deletion-review-checklist
description: GDPR deletion/export (userDataInventory, deleteUserCompletely) review checklist — legal-text drift, best-effort steps that block, shared device rows, in-flight writers
metadata:
  type: project
---

Findings from the first review of account deletion + export (2026-10-04, feat/account-deletion-export). Re-check these whenever the inventory, deletion or the privacy policy changes.

- **Privacy-policy text vs stored data.** The policy promised "only a record that the account id was deleted is kept", but the tombstone stored the email too. Diff `client/src/legal/privacy-policy.md` against what the code actually keeps.
- **"Best-effort" pre-steps must not be able to block the hard delete.** `calendarIntegrationsDAO.findByUserDecrypted` throws on any undecryptable row, and googleapis `stopWatch` has no timeout. Either one stops deletion before a single row is removed, and the user cannot delete their account. Token reads and Google calls need a per-row try/catch plus a timeout.
- **Rows shared across co-resident accounts.** `pushSubscriptions` is keyed by deviceId; its `user` field is informational, and `staleDevices` only deletes a subscription once no account on the device still uses it. A plain `{user}` filter breaks push for the other accounts on that device.
- **Writers already in flight re-create rows.** Writes that authenticated before the parallel `deleteMany` still land afterwards: `/sync/push`, the client-driven GCal sync running under `withSyncLock`, and the fire-and-forget `deviceUsers` upsert in `authenticateRequest`. Ask for auth to be cut first, in-flight syncs drained, and a final sweep.
- **Idempotency claims vs `replaceOne`.** A re-run that replaces the tombstone overwrites the first run's email/deletedAt with null and the new time. Use `$setOnInsert`.
- **Better Auth OAuth-state `verification` rows are keyed by a random `state` string, not by email**, so an `identifier: email` filter matches nothing for OAuth users.

Round two (2026-10-04) added these:

- **Check every claimed fix in the code.** The handoff said "`deleteUser.ts --user-id` refuses an unknown id". It did not, and no test covered it. Grep for the claimed behaviour and for its test.
- **One Google grant can serve several GTD users.** Sign-in and calendar use the same OAuth client, so revoking a token kills the grant for that client + Google account. That includes ANOTHER GTD user's calendar integration on the same Google account. This applies to deletion AND to calendar disconnect. Ask for an "is another user still using this Google account?" check before revoking.
- **In-memory coordination does nothing from the admin CLI.** `drainCalendarSyncLocks` (KeyedMutex) and `broadcastAccountDeletedAndClose` (SSE map) only exist in their own process. `scripts/deleteUser.ts` runs in a separate process, so for the CLI they are silent no-ops. The CLI path leans on the final sweep alone.
- **New waits added to the deletion path must be bounded too.** The rewrite added `await drainCalendarSyncLocks(...)` with no timeout, after sessions were already cut. A hung sync leaves the user logged out with their data still present and no tombstone.

**How to apply:** the inventory test pins owner fields against hand-written fixtures, so it cannot catch any of the issues above. Check them by hand. See also [[snapshot-replace-defeats-lww-on-concurrent-edits]] and [[log-redaction-error-object-dumps]].

Round three (2026-10-04): all round-two claims verified in code + tests; approved. Leftovers worth a glance next time:

- **Drain test discriminates by timing only** (sync sleeps 150 ms, deletion runs ~30 ms locally). Proven by mocking `drainCalendarSyncLocks` to a no-op: the test fails. A slow CI Mongo could make it pass without the drain, though. A deterministic version asserts inside the sync that no tombstone exists yet.
- **Inserting a new JSDoc block above an existing declaration orphans the old one.** It happened in rateLimitMiddleware (`InMemoryStore`). Check for two adjacent `/** */` blocks.
- **Test-side `as never`** on raw `db.collection(...)` calls persisted after the production casts were removed. The fix is typed collections or DAOs.
