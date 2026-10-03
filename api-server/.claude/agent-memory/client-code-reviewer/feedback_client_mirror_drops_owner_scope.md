---
name: client-mirror-drops-owner-scope
description: Client-side ports of server merge/carry rules lose the server's implicit owner + event-identity scoping (findByOwnerAndId, describesSameEvent); cross-account reassign rows get contaminated.
metadata:
  type: feedback
---

When a server-side merge rule (e.g. calendar link carry-forward) is mirrored into the client pull
path (`applyEntityOp`), the client version tends to drop scoping the server got for free: the
server reads the existing row via an owner-scoped DAO lookup and gates link groups on
same-event/same-integration; the client IDB row is keyed by `_id` only, so a row that belongs to
another account (cross-account reassign: target row lands before the source account's older ops
are pulled) or describes a different event gets merged into.

**Why:** found 2026-10-03 on fix/calendar-link-carry-forward — the client
`mergeServerOwnedCalendarFields` had no userId guard and merged link fields one by one, while the
server reassign deliberately strips every GCal field from the target snapshot.

**How to apply:** for any client "losing snapshot still contributes fields" logic, check (1)
`local.userId === incoming.userId`, (2) the field group is merged as a unit with an identity check
matching the server mirror, (3) whether the e2e actually discriminates the client half or is
satisfied by the server echo alone. Related: [[stale-row-snapshot-write-back]].
