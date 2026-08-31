---
name: tz-dependent-date-tests
description: Client date tests pass only in the author's positive-offset TZ; `new Date('YYYY-MM-DD')` fixtures flip a day under America/*.
metadata:
  type: feedback
---

Client date/routine tests routinely encode the author's local timezone. Re-run any suite touching
date arithmetic with `TZ=America/New_York npx vitest run <files>` before approving — "all 1574
tests pass" is a claim about one timezone.

**Why:** the author runs a positive-UTC-offset TZ (Asia/Jerusalem). Fixtures written as
`new Date('2025-06-01')` are **UTC midnight**, which is May 31 locally in every America/* zone, so
any code that converts the value to a *local* calendar date flips a day. Measured on the tickler
day-boundary review: 6 client tests fail under `TZ=America/New_York` on an otherwise-green tree
(`routineItemHelpers`, `routineStartDate`, `rruleUtils`, …) — largely pre-existing, and a change
that converts a timestamp anchor to a local-calendar-date anchor silently changes which of them
fail.

**How to apply:** when a diff moves between "raw timestamp" and "local calendar date" semantics,
run the affected tests under both a positive- and a negative-offset TZ and report the delta
against the pre-change baseline (`git stash` the source file, re-run) so pre-existing fragility
isn't misattributed to the diff. Prefer fixtures built from explicit local wall-clock strings
over `new Date('2025-06-01')`:
- **local midday** (`dayjs('2025-06-01T12:00:00').toDate()`) when the date itself is the assertion —
  local and UTC calendar dates agree in every real zone, so the expectation is TZ-independent.
- **local evening** (`…T21:00:00`) when the *point* is that the UTC day has already advanced —
  that fixture is what actually pins a local-vs-UTC anchor bug.

Verified on the tickler day-boundary fix: converting the fixtures this way took the two touched
files green across UTC-11 → UTC+14 (incl. Kathmandu +5:45 and Chatham +12:45) and dropped the
whole-suite `TZ=America/New_York` failure count 6 → 4; the residue (`rruleUtils`, `routineSplit`,
`itemMutations`) is pre-existing and worth a separate pass.
Related: [[module-singleton-stale-snapshot]].
