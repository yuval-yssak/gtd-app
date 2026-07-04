---
name: webhook-lapse-catchup-410-selfheal-tested
description: FIXED 2026-07-02 — lapsed-channel catch-up now has a 410→full-sync→reconcile-trash test + SSE/web-push fan-out assertions. Memo kept as a review-checklist reminder.
metadata:
  type: project
---

FIXED 2026-07-02: webhookRenewal.test.ts now has "heals an expired syncToken during catch-up: 410 → full sync + reconcile sweep trashes the stranded item" (rejects `listEventsIncremental` with `SyncTokenInvalidError`, asserts `fullSpy` called once, stranded item with 3-day-old `updatedTs` trashed + `cancelledByGCal`, syncToken → `tok-full`). Fan-out also covered: cancellation test spies `notifyUserViaSse` + `notifyViaWebPush` (both called); no-gap test asserts SSE NOT called. Memo kept as a review reminder for future catch-up/reconcile work.

Original gap: `renewWebhookAndCatchUp` drains the notification gap after a lapsed webhook channel. Its docstring sells "an expired token self-heals via the 410 → full-sync + reconcile path inside syncSingleCalendar" as the load-bearing incident-recovery property (the staging incident was a stranded cancellation). The initial tests only covered the still-valid-syncToken incremental path — the 410/`SyncTokenInvalidError` → `listEventsFull` → reconcile-sweep-trashes-orphan path was untested (the helper stubbed `fullSpy` but never asserted it).

**Why:** Full-sync + reconcile is the branch that actually trashes stranded items; the surviving-token incremental branch is the cheap-and-common case, not the recovery case.

**How to apply:** When reviewing any lapse/catch-up/reconcile change, demand a test where `listEventsIncremental` rejects with `SyncTokenInvalidError`, `listEventsFull` returns an empty (or reduced) snapshot, and a live local item gets trashed by the reconcile sweep. Assert `fullSpy` was called. Also flag that these catch-up tests assert DB end-state but skip SSE/web-push fan-out assertions — the notification gap is a user-facing concern; spy on `notifyViaWebPush`/`notifyUserViaSse`.
