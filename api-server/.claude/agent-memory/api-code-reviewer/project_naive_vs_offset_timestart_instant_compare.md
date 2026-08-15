---
name: naive-vs-offset-timestart-instant-compare
description: Routine-generated timeStart is offset-NAIVE while GCal-sourced newTimeStart carries an offset — dayjs().valueOf() on both is TZ-dependent and silently misses on UTC servers
metadata:
  type: project
---

Two `timeStart` representations coexist and are routinely compared:

- **offset-naive** — `` `${date}T${timeOfDay}:00` ``, emitted by `buildItemTiming`
  (`lib/routineItemRegeneration.ts`) and `deriveExceptionItemTimes` (`routes/calendar.ts`). This is
  the shape of every routine-*generated* row.
- **offset-explicit** — `…+03:00` or `…Z`, whatever GCal returned, stored on
  `routineExceptions[].newTimeStart` and on GCal-originated item rows.

`dayjs(naive).valueOf()` resolves in the **server's local zone**. Measured for the same wall time:
`TZ=Asia/Jerusalem` → naive === offset (matches); `TZ=UTC` → 3h apart (silent miss). Cloud Run runs
UTC; the dev machine runs Asia/Jerusalem. So instant comparisons pass locally and no-op in prod.

**Why:** a tier-3 exception lookup matched legacy rows by `dayjs(timeStart).valueOf()` against a
stored prior `newTimeStart`. Its headline benefit (letting `revertItemToMasterTime` find shifted
rows) targets exactly the naive-stored generated rows, so it was inert in production. The shipped
tests stored rows as `…Z` and exceptions as `+03:00` — offset-explicit on **both** sides — so they
passed identically under `TZ=UTC` and proved nothing.

**How to apply:** any new instant/valueOf comparison touching `timeStart` must resolve naive strings
in the calendar's zone (`SyncContext.timeZone`, already threaded — `isExceptionBeforeToday` uses it),
detecting the naive case via a `/([Z]|[+-]\d{2}:\d{2})$/` suffix test. In review, check the fixture:
if both sides carry an offset, the test does not discriminate — demand a naive-stored row plus a
pinned `TZ=UTC`. Also note `dayjs('YYYY-MM-DD').valueOf()` (all-day rows) is *local* midnight, not
UTC. Cross-link [[timestart-offset-lexicographic-compare]] and
[[calendar-test-local-startofday-tz-fragility]].

**Resolved shape (2026-08-15, `toInstant(time, timeZone)` in `routes/calendar.ts`)** — branch on
`/(?:Z|[+-]\d{2}:?\d{2})$/`: explicit-offset → plain `dayjs(time)`; naive → `dayjs.tz(time, tz ?? 'UTC')`.
Reuse this helper rather than re-deriving. Two bonuses worth knowing: all-day `YYYY-MM-DD` takes the
naive branch and becomes midnight **in the calendar zone** (the semantically right answer), and
`dayjs.tz` **throws RangeError** on unparseable input where plain `dayjs` returned a silent `NaN` —
which is safe here only because `floatingDateTime` (`schemas/operations/shared.ts`) already enforces
`.min(1)` + `Date.parse` validity on every `timeStart` / `newTimeStart` write path.
