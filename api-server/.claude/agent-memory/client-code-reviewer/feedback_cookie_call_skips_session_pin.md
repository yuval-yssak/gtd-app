---
name: cookie-call-skips-session-pin
description: New cookie-authed fetches from Settings/components skip withActiveAccountSession, so they hit whichever account the drifted Better Auth cookie points at
metadata:
  type: feedback
---

New code that calls a cookie-authed endpoint "for the account on screen" (seen 2026-10-04: DELETE /auth/me + GET /export in AccountDataSection) calls fetch directly instead of wrapping it in `withActiveAccountSession` / `withAccountSession`. Switching accounts writes only IDB and reloads, so the cookie can point at a different signed-in account. For destructive calls that means the wrong account gets deleted.

**Why:** the IDB-active vs cookie-session drift has caused several shipped bugs (calendar 404s, GCal connect stamping the wrong account). Every new surface repeats the mistake because plain fetch looks fine on a single-account test device.

**How to apply:** for every new `credentials: 'include'` call that a component triggers, check that it goes through the session-pin wrapper. For destructive calls, also check that the server's returned userId is compared with the intended account before any local wipe. Related: [[client-mirror-drops-owner-scope]].
