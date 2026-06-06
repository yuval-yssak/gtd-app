---
name: resolve-calendar-context-no-degrade
description: resolveCalendarContext docstring promises graceful degradation to no-calendar on failure, but has no try/catch — a corrupt integration's decrypt throw 502s every clarify request
metadata:
  type: project
---

`resolveCalendarContext` (src/lib/claude/tools.ts) is documented as "Failures resolve to undefined — a missing calendar just omits the tool rather than failing the whole clarify request," but the implementation has **no try/catch**. It calls `calendarIntegrationsDAO.findByUserDecrypted`, which maps `decrypt()` over every integration row; `decrypt` THROWS on a corrupt/malformed ciphertext or GCM auth-tag mismatch (wrong `CALENDAR_ENCRYPTION_KEY`).

The throw bubbles through `runClarifyLoop` (bare `await resolveCalendarContext(...)` at agentLoop.ts ~line 96, also no try/catch) up to the route handler, which returns **502 agent_error**. So a single corrupt integration row makes EVERY clarify request for that user fail — even requests that never touch the calendar.

**Why:** Lane A step (d) added gated calendar reads. The Lane A design principle is that calendar is an optional enrichment that should degrade gracefully, never a hard dependency of clarify.

**How to apply:** On any "resolve optional enrichment up front" helper whose docstring claims it degrades on failure, verify there is an actual try/catch returning the degraded value. Decrypt-bearing DAO reads (findByUserDecrypted / findByOwnerAndIdDecrypted) are throw sites. Demand a test that seeds a corrupt integration (bad ciphertext) and asserts the clarify request still 200s with the calendar tool omitted. Related: [[signing-key-dev-fallback-weak-guard]].
