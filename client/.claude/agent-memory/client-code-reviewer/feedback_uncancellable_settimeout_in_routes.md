---
name: uncancellable-settimeout-in-routes
description: Route components defer route changes / state actions with setTimeout but skip cleanup, leaving stale timers firing after manual user navigation.
metadata:
  type: feedback
---

When a route component schedules a `setTimeout` to defer a `navigate(...)` (or any other one-shot side effect) so that an in-flight UI affordance can finish — e.g. wait 3s for a Snackbar to be readable before tearing the route down — verify two cleanup paths are present:

1. A second invocation of the same handler (e.g. user clicks the header Back button during the deferred window) must `clearTimeout` the pending one before taking action, otherwise both navigations fire and the user gets yanked to a stale destination 3s later.
2. A `useEffect` cleanup on unmount must `clearTimeout` so a route teardown via any other path (parent route change, programmatic redirect, fast-refresh) doesn't leave the timer pointing at a stale `navigate` closure.

**Why:** Seen on `routes/_authenticated/item.$itemId.tsx` `goBack` — page-mode editor scheduled `setTimeout(navigate, 3000)` after a fromGmail done-transition to let the Snackbar paint, but had neither (1) nor (2). User pressing Back manually during the window triggered both an immediate navigate and the stale deferred one, yanking the user 3s after they thought they'd settled. The pattern is more general than this one route — anywhere a deferred-action setTimeout is introduced to coordinate with a fading UI element, both cleanup paths are required.

**How to apply:** When reviewing any new `setTimeout` inside a route or hook, scan for: (a) is the id stored where re-entry can clear it? (b) is there an unmount cleanup? If either is missing, flag as a race-condition critical even if the window is short — the symptom (post-unmount navigation) is hard to debug from telemetry.

Related: [[page-mode-autofocus]] — page-mode editor surface has surfaced multiple lifecycle-coordination bugs because it bypasses `useItemEditor`'s host responsibilities (Snackbar slot, focus management, etc.) and reimplements them inline.
