---
name: multisession-cookie-renewal-newsession
description: Better Auth multi-session cookie renewal keys on ctx.context.newSession; server-side getSession in auth middleware slides the DB session but never rewrites browser cookies; newSession can be stale
metadata:
  type: project
---

The multi-session `_multi-<token>` cookie renewal (after-hook, 2026-10) fires only when `ctx.context.newSession` is set by a browser-facing /auth/* call. Facts verified in better-auth 1.5.6:
- User `hooks.after` runs BEFORE plugin after-hooks; hooks append Set-Cookie.
- `auth/middleware.ts` now forwards getSession's refresh Set-Cookie (2026-10-14), but ONLY cookies the request already holds, and never the MAIN session cookie on a device holding `_multi-` cookies: an ungated response landing after a client `set-active` pivot would point the cookie back at the previous account, and `/sync/pull` has no misroute guard (only push does). Any new server path that writes the main session cookie outside /auth/* must keep that rule.
- `sessionMiddleware` (e.g. /multi-session/revoke) can set `newSession` via a nested refresh; if the handler then deletes that session, `newSession` stays stale — renewal hooks must skip a cookie the response already expires.

**How to apply:** For changes to session/cookie lifetime, check both the stale-newSession case and whether a middleware-only refresh leaves browser cookies unrenewed.
