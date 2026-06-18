---
name: full-sync-reconcile-instance-id-blindspot
description: Full-sync reconcile sweep false-trashes non-routine items holding instance-form calendarEventIds because singleEvents:false returns masters + normalizeMasterEventId doesn't strip instance suffix
metadata:
  type: project
---

The inbound GCal full-sync reconciliation sweep (`reconcileVanishedCalendarItems` in routes/calendar.ts) trashes in-window non-routine `calendar` items whose `calendarEventId` is absent from the full-sync event set.

**Why this has a blind spot:** `listEventsFull` uses `singleEvents:false`, so recurring series come back as **masters** (id = bare `evt`), never expanded instances. `normalizeMasterEventId` strips only the `_R<date>` rebased-master suffix — NOT the `_<YYYYMMDDTHHMMSSZ>` instance suffix (proven by calendarInstanceEventId.test.ts:323). So any non-routine standalone item carrying an instance-form id (`evt_20260601T120000Z`) normalizes to itself, misses `presentEventIds`, and is false-trashed.

**Status (2026-06-18, corrected):** FIXED in code. The FIRST attempted guard `normalizeMasterEventId(eventId) !== eventId` was WRONG — `normalizeMasterEventId` strips only the `_R\d{8}...` rebased suffix, never the `_<YYYYMMDD[THHMMSSZ]>` instance suffix, so the round-trip never detected instance ids (a regression test caught this). The CORRECT guard is a dedicated `isInstanceFormEventId(eventId)` (regex `/_\d{8}(T\d{6}Z)?$/`) in routes/calendar.ts, matching exactly the two suffixes `buildCalendarInstanceEventId` emits (`_YYYYMMDD` all-day, `_YYYYMMDDTHHMMSSZ` timed). `isVanishedInWindow` normalizes `_R` first (disjoint from instance form — `R` vs digit after `_`), then tests instance form. The two-suffix families never collide. Fix lives in the predicate, NOT the Mongo query.

**Test coverage:** regression test `'does NOT trash a non-routine item whose calendarEventId is in instance form'` (id `mastermtg_20260620T120000Z`) now exists and is discriminating. GAP: it covers only the TIMED instance form — no companion test for the all-day form (`_<8 bare digits>`), the subtler branch of the regex's optional group.

**False-positive note:** regex would theoretically match a bare-master id ending in `_<8 digits>`, but that's unreachable — Google master ids are opaque base32hex with no underscore; the underscore is introduced ONLY by the routine instance/rebase machinery, so any underscore-suffixed non-routine id IS instance form.

**How to apply:** On any FURTHER change to this sweep, re-verify `isInstanceFormEventId` still gates after `normalizeMasterEventId`, and demand an all-day-instance-form regression test if not yet added. Do NOT reach for `normalizeMasterEventId(id)!==id` as an instance-form detector — it does not strip instance suffixes. Relates to [[gcal-split-successor-onboarding]]-style id-normalization sharp edges and [[id-normalization-asymmetry-pattern]].
