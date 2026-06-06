---
name: assist-cors-echo-any-csrf
description: RESOLVED — assistCors now pins origin to clientUrl in prod (mirrors strictCors) + has a foreign-origin→null test. Kept for the general rule on credentialed CORS.
metadata:
  type: project
---

RESOLVED on feat/claude-assist-lane-a: `assistCors()` now uses the exact `strictCors` origin policy (`origin === clientUrl ? origin : null` in prod, echo in dev) with `credentials:true`, doc comment corrected to state the cookie is `sameSite:'none'`, and `cors.test.ts` has a prod foreign-origin→null assertion. The rules below remain the durable takeaways.

Original bug (now fixed): `assistCors()` (corsProfiles.ts) on `/v1/claude/*` was shipped echoing ANY request Origin with `credentials: true`, justified by a comment claiming the session cookie "is SameSite, browser only attaches it for the SPA's own origin." That premise is FALSE in production: `betterAuth.ts` sets the prod cookie `sameSite: 'none'` (required because SPA on Cloudflare Pages and API on Cloud Run are cross-domain). So the cookie rides cross-site, and echo-any+credentials gives a malicious origin a credentialed read+write CSRF surface (read the ClarifyProposal + executeToken, then drive /assist/apply).

**Why:** every other cookie-authed route (`/sync`, `/calendar`) uses `strictCors`, which in prod pins `Allow-Origin` to `clientUrl` and returns `null` for foreign origins — that origin pin IS the CSRF backstop for this codebase's cookie auth model. `auth.api.getSession` does NOT enforce `trustedOrigins` (that check lives only in `auth.handler`'s POST path), so there's no Better Auth backstop on the assist path. Fix = make `assistCors` mirror `strictCors`'s prod origin pin.

**How to apply:**
- Any new credentialed CORS profile (`credentials:true`) MUST pin origin to `clientUrl` in prod, never echo-any. Treat echo-any+credentials as an automatic critical.
- When a comment claims "SameSite cookie protects this," verify against `betterAuth.ts` — prod is `sameSite:'none'`, NOT lax/strict.
- CORS only hides the *response* / blocks non-simple preflighted requests. A SIMPLE cross-site POST (`Content-Type:text/plain`) is still SENT with the cookie; Hono `c.req.json()` does unconditional `JSON.parse` regardless of Content-Type, so the body parses. The whole cookie surface (`/sync` included) lacks an explicit `Origin`/`Sec-Fetch-Site` check — pre-existing, worth a follow-up.
- Test trap: `cors.test.ts` assist tests only ever used `SPA_ORIGIN`, so they passed under the insecure echo-any impl. Demand a prod foreign-origin → null-Allow-Origin assertion, symmetric to the existing strictCors one.
