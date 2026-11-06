---
name: feedback-capability-fallback-misses-consumer-gate
description: Hooks with a "no API → behave as before" fallback set the state field the hook test checks but not the counter/flag the consumer page also gates on, so the fallback path hangs.
metadata:
  type: feedback
---
When a new hook wraps a browser capability (Web Locks, BroadcastChannel, …) and documents a fallback ("no Web Locks → always 'held'"), check every gate the CONSUMER puts on the hook's return value, not just the field the hook's own test asserts. Seen in the weekly-review tab lock (2026-11-06): the fallback returned `state: 'held'` but left `generation: 0`, and the page's draft-load effect returned early on `generation === 0` → spinner forever. The hook test only asserted `state`.

**Why:** fallback branches are never hit in Chromium e2e and unit tests check the hook in isolation, so the composed fallback is untested by construction.

**How to apply:** for any capability-gated hook, trace the fallback return through each consumer condition; demand a test asserting the full fallback return shape (or a page-level test with the API removed).

Related: also check lock/ownership hooks for (a) state not reset to pending when the key/name changes, (b) one-shot intent (steal/takeOver) persisting into later effect runs, (c) retry-on-reject loops that do not discriminate AbortError. See [[feedback-fixed-critical-ships-without-its-e2e]].
