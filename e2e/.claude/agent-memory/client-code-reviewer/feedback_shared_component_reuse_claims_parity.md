---
name: shared-component-reuse-claims-parity
description: "Reads like a one-off" refactors reuse the shared panels but hand-roll the headline, diverging on time format and dropping the multi-day all-day range helper.
metadata:
  type: feedback
---

When a diff's stated intent is "make surface X look like surface Y" (e.g. the weekly-review
routine card adopting the calendar entry's presentation), reuse of Y's *panels*
(`CalendarEventLinks`, `MeetingDetails`) is what gets reviewed and lands correctly — but the
**headline / leading label is hand-rolled fresh** and silently diverges from Y:

- **Time format**: the new formatter picks `HH:mm` while the canonical page (`calendar.tsx`
  `TimeColumn`) renders `h:mm a`. There is exactly one `h:mm a` call site in the whole client,
  so a grep for "the convention" finds nothing and the author invents one.
- **Multi-day all-day range dropped**: `calendar.tsx` has `buildAllDayRangeLabel` +
  `lib/allDayDate.ts` (`formatAllDayDate`, `fromGCalExclusive`) precisely because GCal `timeEnd`
  is exclusive. A fresh `if (allDay) return \`${date} · all day\`` loses the range AND re-opens
  the exclusive-end bug those helpers exist to fix.
- **Relative-time cue on an all-day date**: a bare `YYYY-MM-DD` parses to local midnight, so
  `start.from(now)` on tomorrow's all-day event reads "in 9 hours", not "tomorrow". The
  `isSame(now,'day') ? 'today' : from(now)` shape only reads right for timed events.

**Why:** parity is asserted in the doc comment and the PR description, so reviewers check that
the *shared components* are wired and stop there. The divergence lives in the ~10 new lines that
were NOT shared.

**How to apply:** on any "reads like / mirrors <other surface>" diff, open the other surface's
renderer and diff the format strings and the all-day branch field by field. Ask specifically:
which helper does the canonical page call that the new formatter reimplements inline?

Related: [[feedback_mirror_the_page_ignores_view_toggles]],
[[feedback_extracted_body_diverges_from_shared_chrome_type]],
[[feedback_page_filter_change_desyncs_review_stages]]
