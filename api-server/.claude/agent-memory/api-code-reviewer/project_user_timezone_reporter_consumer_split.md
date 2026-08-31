---
name: user-timezone-reporter-consumer-split
description: Only /sync writes the user timezone but only /v1 + reassign read it — API-only users are permanently UTC; a garbage stored tz used to 500 five call sites, now guarded inside resolveUserTimezone
metadata:
  type: project
---

`resolveUserTimezone(userId)` reads `deviceSyncState.timezone`, which is written **only** by
`/sync/bootstrap` and `/sync/pull` (`timezoneReportFields` in `routes/sync.ts`). But the
consumers — `ensureFirstRoutineItem`, `advanceRoutineAfterDisposal`,
`recomputeOpenItemSchedule`, `pauseRoutine`, `resumeRoutine` — are reached **only** from
`/v1/*` and the reassign orchestrator. The first-party `/sync` path never calls them; the
client generates its own routine items locally in `client/src/db/routineItemHelpers.ts`.

Consequences to re-check on any follow-up work:
- A user who only ever touches the app through the public API / MCP (never opens a browser
  client) has no `deviceSyncState` row carrying a timezone, so every server-generated
  `expectedBy`/`ignoreBefore` silently falls back to the UTC day. The fallback is correct by
  design but is invisible — there is no signal distinguishing "UTC user" from "never reported".
- `POST /sync/push` writes `lastSeenTs` but does NOT carry a timezone report. A Service-Worker
  background-sync flush pushes with no subsequent pull, so a device that has relocated can go a
  long time before refreshing its report.

**Poison-row blast radius (fixed 2026-08-30):** every one of the five consumers resolves the
timezone OUTSIDE its error handling — the two generators resolve it *before* their "generation
must never fail the parent request" try blocks, and `pauseRoutine`/`resumeRoutine` have no
try/catch at all. So a single unresolvable `deviceSyncState.timezone` value used to RangeError
out of `dayjs().tz()` and 500 routine create, complete, trash, pause and resume for that user.
The guard now lives inside `resolveUserTimezone` (re-validate + fall back to UTC), which is the
right layer precisely because the callers can't be relied on to catch.

**How to apply:** any NEW consumer of `resolveUserTimezone`/`userLocalDate` inherits the guard
for free — but if someone ever moves validation out to the call sites, re-check all five. And
note the tz is only *reported* on bootstrap/pull, so "the value is validated at the route" is
never sufficient: rows also arrive via mongosh edits and can be invalidated by an ICU upgrade
retiring an alias.

**Deliberately server-local sites:** `lib/routineItemRegeneration.ts` still uses
`dayjs().startOf('day')` in `getValidFutureOccurrences`, `propagateRoutineTitleToItems`,
`propagateRoutineContentToItems`, and `futureLiveItemsByDate`. This is BY DESIGN and carries a
module-level NOTE saying so — calendar items key off `timeStart` (wall-clock event times),
never the tickler boundary. Do not "fix" these to user-local without re-deriving the argument.

**Why:** the user-local-day convention applies only to nextAction `expectedBy`/`ignoreBefore`
stamping, which is what the client's local-midnight tickler visibility filter compares against.

Relates to [[project_id_normalization_asymmetry_pattern]] — a half-converted set of sites
recreates the bug from the other direction. See also
[[project_timezone_fixture_tests_wallclock_vacuous]] for how to test these paths.
