---
name: app-parity-claims-check-client-source
description: Server code claiming "mirrors the app order/page" repeatedly drifts from the client source (nav order, tickler hiding, calendar all-day/instant rules) — verify against the client files, not the PR summary
metadata:
  type: feedback
---

When a server change claims "the order the app shows" or "mirrors the client", open the client code it names AND
the pages that render it. Drift found on 2026-11-01 (`sort=priority`): status order did not match `AppNav`/`ACTIVE_STATUSES`
(calendar before waitingFor in the app), tickler-hidden rows (`isTicklerHidden`) were mixed into their lists, and the
calendar comparator compared `timeStart` strings lexically where the client (`calendarRouteSort.ts`) groups by local
day, puts all-day first and compares instants.

**Why:** the PR summary and tests encode the author's belief about the app, so tests pass while the parity claim is false.

**How to apply:** for each claimed parity, list the client predicate/comparator and check every branch; demand a
fixture that discriminates (mixed naive/offset timeStart under a non-UTC zone, a snoozed row). See
[[naive-vs-offset-timestart-instant-compare]].
