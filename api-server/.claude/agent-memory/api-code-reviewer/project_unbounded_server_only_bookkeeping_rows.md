---
name: unbounded-server-only-bookkeeping-rows
description: New server-only (non-synced) Mongo collections ship without TTL/retention and leak rows on any crash between paired writes — and a TTL index only fires on a BSON Date, never an ISO string
metadata:
  type: project
---

Server-only bookkeeping collections (not synced entities, no client, no op log) are repeatedly added
with cleanup done *only* on the happy path — an explicit `deleteByX` at the end of a successful
lifecycle — and no retention bound. Two leak shapes show up every time:

- A crash between paired writes (create child rows, then the parent row; or mark parent terminal,
  then delete child rows) orphans the children with no query that will ever find them again,
  because the reaper enumerates by the *parent's* status.
- Terminal parent rows (`harvested` / `expired` / `failed`) are never deleted at all, so the
  collection grows monotonically.

**Why:** the deployment target is an Atlas M0 with a 512 MB write-blocking quota, and op-log bloat
has already taken staging down once — an unbounded collection is not a theoretical concern here.

## TTL indexes: the field MUST be a BSON Date

Mongo's TTL monitor only reaps documents whose indexed field is a BSON `Date` (or an array of
Dates). A TTL index on an **ISO-datetime string** is accepted by `createIndexes`, shows up in
`listIndexes` with its `expireAfterSeconds`, and **never deletes anything** — it fails silently.

Verified empirically against the repo's Mongo 8.0 test container (2026-09-21): two TTL indexes on
one collection, one doc with a past ISO string and one with a past `Date` — the Date row was reaped
within ~30 s, the string row survived indefinitely.

Status 2026-11-11: the three legacy string-TTL indexes (`apiTokens`, `oauthRefreshTokens`,
`oauthAuthCodes`) were the root cause of a prod user accumulating 348 OAuth access-token rows. The
fix (worktree gtd-device-last-seen, reviewed 2026-11-11) adds `lib/ttlExpiry.ts` — `expiryFields()`
writes both the ISO `expiresTs` (read-time checks) and a BSON `expiresAt` twin (TTL), and
`ensureExpiresAtTtl` drops `expiresTs_1` + backfills on boot. If that merged, `ttlExpiry.ts` is the
pattern; verify before citing. Recurring hazard: every NEW writer of these collections must use
`expiryFields()` — a writer that sets only `expiresTs` silently re-creates the original leak. The
first draft tested only the access-token writer; the approved version also asserts the code and
refresh rows (oauthExpiryTtl.test.ts) — a new writer needs the same assertion.

**How to apply:** for any new non-synced collection, ask (1) what deletes a row when the happy path
does not complete, and (2) what bounds the collection's size a year out. Expect a dedicated
`expiresAt: Date` field (BSON Date, distinct from the ISO `createdTs`/`expiresTs` the rest of the
codebase uses for business logic) plus `{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }` in the
DAO's `init()`. A test should assert both `instanceof Date` and the index spec read back via
`listIndexes`. Related: [[brief-sweep-mine-fail-open-cooldown]], [[unguarded-index-build-on-boot]].
