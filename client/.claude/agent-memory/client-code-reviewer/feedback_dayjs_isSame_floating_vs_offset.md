---
name: dayjs-issame-floating-vs-offset
description: Comparing a routine-generated item's floating timeStart against a GCal-sourced offset-bearing newTimeStart with plain dayjs().isSame() is browser-timezone-dependent — it silently passes on the author's machine and fails for users elsewhere.
metadata:
  type: feedback
---

Client code that matches a routine occurrence against a `routineExceptions[].newTimeStart` must not use bare `dayjs(a).isSame(dayjs(b))`. The two sides have systematically different shapes:

- Routine-generated rows store **floating wall-clock** `timeStart` (`${date}T${timeOfDay}:00`, no offset) — see `routineItemRegeneration.ts` `buildItemTiming` and the server's own `toInstant`/`EXPLICIT_OFFSET_RE` helper, which exists precisely because plain `dayjs()` on a naive string picks up the *local* zone.
- `newTimeStart` comes straight from GCal `event.start.dateTime` and always carries `Z` or `±HH:MM`.

Bare `dayjs()` resolves the floating side in the **browser's** zone, so the comparison passes only when the user's zone equals the calendar's zone. Verified empirically: the same assertion returns true under `TZ=Asia/Jerusalem` and false under `TZ=America/New_York`.

**Why:** the server hit this exact class of bug already (it caused duplicate calendar items) and fixed it by normalizing both sides to an instant in the calendar's timezone. The client has no `timeZone` in scope, so the safe client-side equivalent is string comparison on the shared prefix / date, not instant math.

**How to apply:** flag any client-side instant comparison between an item `timeStart` and a GCal-sourced datetime. Ask for either (a) offset-aware normalization with an explicit zone, or (b) a shape-agnostic comparison (compare the `YYYY-MM-DD` prefix, or string equality since the write path assigns `timeStart = ex.newTimeStart` verbatim). Require a test that pins the assertion under a non-local `TZ` — a unit test that only runs in the author's zone proves nothing.
