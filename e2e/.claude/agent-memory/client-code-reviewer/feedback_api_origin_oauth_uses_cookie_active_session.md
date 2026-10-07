---
name: api-origin-oauth-uses-cookie-active-session
description: Flows served on the API origin (MCP /mcp-oauth/authorize, GCal connect) bind to the Better Auth cookie-active session, not the app's IDB-active account; user-facing copy promising "sign in with that account" is false for multi-account users
metadata:
  type: feedback
---

API-origin OAuth pages (`/mcp-oauth/authorize` consent, calendar connect) call `auth.api.getSession` and use whichever Better Auth session the cookie marks active. The in-app account switch (`performLocalAccountSwitch`) is IDB-only and never moves that cookie, and the consent page has no "use a different account" link. So a user already signed in to the app skips the sign-in page entirely and lands on consent for the cookie-active account.

**Why:** 2026-10-07 Connect Claude guide said "add a second connector and sign in with that account" and "A browser window opens. Sign in…" — neither happens for a signed-in multi-account browser; the guide offered no recovery when the email is wrong.

**How to apply:** for any user-facing guide/copy that describes an API-origin OAuth step, check (1) the signed-in-already path (no sign-in page), (2) the wrong-account recovery is stated and actually works given IDB-vs-cookie divergence. Related: [[oauth-reauth-lands-on-wrong-account]].
