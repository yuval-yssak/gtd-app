---
name: rrule-series-end-reinvented-without-guards
description: New "series end / past COUNT" rrule helpers keep getting rewritten from scratch, dropping the MAX_EXPANDABLE_COUNT bound and the malformed-rrule try/catch that effectiveSeriesEndIso already has
metadata:
  type: project
---

An rrule "when does this series end" helper already exists with two load-bearing guards (COUNT cap, treat-as-open on parse throw). New code (2026-11 isPastSeriesEnd) re-derived it with a bare `rule.all()` and no try/catch.

**Why:** rrule schema is regex-only (`/FREQ=/`), so /v1 callers can store `COUNT=200000000` (all() → OOM on the max-instances=1 service) or `UNTIL=NOTADATE` (RRule.fromString throws, turning a formerly-harmless push into a thrown error). Impossible filters (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`) spin rrule to MAXYEAR (~4.6s) even through `between()` — pre-existing everywhere, not fixable by switching to between.

**How to apply:** whenever a diff calls `rule.all()`, reads `rule.options.count/until`, or parses COUNT, grep for an existing series-end helper first and demand reuse; watch for the import cycle (that helper's module imports routineItemRegeneration). Verify claims with a node probe against rrule, not by reading.
