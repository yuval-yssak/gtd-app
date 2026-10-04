---
name: fallback-navigation-clobbers-specific-one
description: A post-pass "belt-and-braces" `location.href = '/'` runs after an inner path already set `/login` — href assignment doesn't halt JS, so the later, vaguer navigation wins
metadata:
  type: feedback
---

`window.location.href = X` starts a navigation but the current task keeps running; a second assignment before unload cancels the first. Found 2026-10-04 (account-deletion round 4): `syncAllLoggedInUsers` evaporated the last account → `signOutToLogin` set `/login`, then `syncAndRefresh`'s new missing-account check set `/`, landing a signed-out user on the public landing page (and racing the e2e's `waitForURL('/login')`). Unit tests inject `onUserDeleted` mocks and the provider has no DOM tests, so nothing composes the two.

**Why:** fallback reload checks get added at the provider layer while the specific navigation lives deep in the sync layer; the orchestrator returns `void`, so the caller can't know a navigation is already scheduled.

**How to apply:** when a diff adds any `location.href`/reload in a caller, trace every callee that can navigate first; demand the callee return `{ navigated }` and the caller bail on it. Related: [[wasactive-read-inside-session-pivot]], [[deferred-side-effect-lost-on-loop-throw]].
