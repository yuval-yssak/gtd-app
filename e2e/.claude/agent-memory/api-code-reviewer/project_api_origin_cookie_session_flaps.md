---
name: api-origin-cookie-session-flaps
description: API-origin Better Auth active session is pivoted by the web app (withAccountSession/reconcile) and prod cookies are SameSite=None — any server-rendered form flow keyed on getSession() needs identity binding + CSRF token
metadata:
  type: project
---

Two traps for any server-rendered HTML flow on the API origin (e.g. hosted MCP OAuth consent) that reads `auth.api.getSession()` at render time and again at form-submit time:

1. The "active" multi-session cookie is NOT stable: the client's `withAccountSession` transiently `setActive`s other accounts during every multi-account sync and restores to the IDB-active one; `reconcileActiveSessionCookie` pivots it back to IDB-active on boot/online. A page rendered for user A can be submitted as user B. Authors have claimed "the web app never moves the cookie" — it does.
2. Prod cookies are `SameSite=None; Secure` (dev is Lax), so cross-site form POSTs carry the session in prod only. Vitest/e2e run with Lax and never reveal CSRF on cookie-authed POST endpoints.

**Why:** found 2026-10-07 reviewing the MCP consent "use a different account" change: /authorize/decision had no CSRF token and minted a code for whichever session was active at submit.

**How to apply:** for any cookie-authed POST on the API origin, require a session-bound CSRF token (or Origin/Sec-Fetch-Site check) and bind the posted decision to the user id that was displayed. Note: this directory is gitignored (root-session memory); copy into api-server/.claude/agent-memory/ if it should persist.
