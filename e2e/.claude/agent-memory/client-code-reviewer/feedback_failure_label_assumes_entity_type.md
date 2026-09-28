---
name: feedback-failure-label-assumes-entity-type
description: New SyncIssuesPanel FAILURE_LABELS entries get worded for the incident's entity (item) though the server reason fires for any entity type sharing the unique index (routines).
metadata:
  type: feedback
---

When a new server `OpFailureReason` is mirrored into the client label map, the wording is taken from the incident that motivated it ("Another item is already linked to this calendar event") while the server emits the reason from a generic path (`applyEntityOp` duplicate-key catch) that also covers routines (`routinesDAO` unique calendarEventId) and other unique keys (items `externalId`).

**Why:** the row's title shows the entity's real name/type, so an item-specific label under a routine row misleads; the client unit test only exercises the default `entityType: 'item'`.

**How to apply:** for every new reason, grep the server for where it is stamped and list which entity types / unique indexes can reach it; demand entity-neutral wording or a per-entityType label, and a test row with `entityType: 'routine'`.
