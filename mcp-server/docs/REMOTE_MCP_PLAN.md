# Plan: Host the GTD MCP server remotely (Cloud Run)

Status: **proposal — not yet built.** Written 2026-06-24.

## Why

Today the MCP is a **local stdio binary** (`node mcp-server/dist/index.js`), launched per-machine
from a cloned repo. That created the failure we just hit: a source change required a per-machine
`npm run build` + a Claude session restart, and the compiled `dist/` silently went stale (May → June).
A `prepare`-hook now rebuilds `dist/` on install, but the underlying limitation remains:

- The server only exists on machines with the repo checked out and built.
- It is unavailable from Claude Desktop, claude.ai (web), or mobile.
- Every config holds raw bearer tokens in a local env block.

A **remote MCP server** (Streamable HTTP transport, hosted beside the API) removes all three: deploy
once, point any Claude client at a URL, done.

## Key enabler (verified)

The installed SDK (`@modelcontextprotocol/sdk@1.29.0`) already ships the pieces we need:

- `server/streamableHttp.js` — the current MCP **Streamable HTTP** transport (replaces the old SSE
  transport; single `/mcp` endpoint, supports both request/response and server-streamed messages).
- `server/webStandardStreamableHttp.js` — a **Web-standard `Request`/`Response`** variant. This is the
  one to use: it plugs directly into **Hono** (which the API already runs on) and into Cloud Run with
  no Express dependency.
- `server/auth/` — OAuth provider/middleware helpers for the spec's remote-auth flow.

This means the remote MCP does **not** need to be a separate service. The cleanest shape is to **mount
it into the existing api-server Hono app** as a new route (`/mcp`), reusing the deploy pipeline, the
Cloudflare Worker, and — critically — the existing bearer-auth middleware.

## Recommended architecture: mount `/mcp` into the existing API

```
Claude client ──HTTPS──> api(-staging).getting-things-done.app/mcp
                          │  (Cloudflare Worker → Cloud Run: gtd-api / gtd-api-staging)
                          │
                          └─> Hono route /mcp
                                ├─ authenticateBearer  (EXISTING middleware, reused as-is)
                                └─ McpServer over webStandardStreamableHttp transport
                                     └─ same tool handlers, calling the v1 API internally
```

Why mount-into-API beats a standalone Cloud Run service:

- **Reuses `authenticateBearer`** (`api-server/src/auth/bearerMiddleware.ts`) — the token model,
  scopes, rate-limit-on-failure, and `lastUsedTs` bump already exist. No new auth surface to build.
- **One deploy pipeline** — the existing `deploy-api.yml` (`gtd-api` / `gtd-api-staging`,
  `us-central1`) and the `gtd-api-proxy` Worker route already cover `api(-staging).getting-things-done.app/*`,
  so `/mcp` is reachable with **zero new infra**.
- The tool handlers can call the v1 service **in-process** (skip the HTTP round-trip to itself), or keep
  calling over HTTP for a clean boundary — both are small.

A standalone `gtd-mcp` Cloud Run service is the alternative, but it duplicates auth, adds a Worker route,
a Dockerfile, and a second deploy — all to re-expose the same v1 API. Not worth it for one operator.

## The hard part: authentication

This is the real work; everything else is plumbing. Three options, in increasing order of effort:

### Option 1 — Bearer passthrough (lowest effort, good for single operator)
Client sends `Authorization: Bearer gtd_<token>` to `/mcp`; the existing `authenticateBearer`
middleware validates it exactly as it does for `/v1/*`. The MCP tool handlers read `c.var.apiAuth.userId`.

- Pro: ~no new auth code; identical security model to the public API today.
- Con: the user pastes a token into the MCP client config (same as today, just a URL instead of a
  binary). The `account: "default" | "work"` multi-account selector **goes away** — each remote
  connection is one token = one user. To drive two accounts you wire **two `mcpServers` blocks**
  (e.g. `gtd` and `gtd-work`), each with its own token + URL. This is arguably cleaner than the current
  in-band selector.
- **Recommended starting point.**

### Option 2 — OAuth 2.1 (the MCP spec's remote-auth standard)
Use `server/auth/` to implement the Authorization Code + PKCE flow. The Claude client discovers the
auth server, the user logs in (could federate to the existing Better Auth Google/GitHub), and the client
gets a short-lived token automatically — no manual token paste.

- Pro: the "correct" remote-MCP UX; no secrets in client config; revocable per-client.
- Con: real work — authorization-server metadata endpoints, token issuance/refresh, consent screen,
  binding the issued token back to a Better Auth user. Weeks, not hours.

### Option 3 — Hybrid
Ship Option 1 now (token passthrough), add Option 2 later if/when multi-user or Desktop/mobile
convenience justifies it. Recommended path.

## Multi-tenancy note

The local server's `account` arg assumes *your two tokens live on your machine*. A hosted endpoint
must key **everything** off the authenticated caller (`c.var.apiAuth.userId`), never a client-supplied
account label. The `accountSchema` selector and `GTD_API_TOKEN_<LABEL>` env model are local-only
concepts and should be dropped from the remote build (replaced by one-token-per-connection).

## What carries over unchanged

- All tool definitions (`tools/items.ts`, `routines.ts`, etc.) and the `url`-stamping decorator
  (`tools/webUrl.ts`). `webBase()` derives from the API base just as it does locally — on Cloud Run
  the API base is known, so deep links keep working.
- The v1 API itself — the MCP stays a thin façade over `/v1/*`.

## Migration / rollout

1. Add `webStandardStreamableHttp` transport + an `/mcp` route to the api-server Hono app, behind
   `authenticateBearer` (Option 1).
2. Move the tool registration out of `mcp-server/src/index.ts` into a shared module both the stdio
   binary and the HTTP route import — so local stdio and remote HTTP serve identical tools. (Keep the
   stdio binary working for offline/dev.)
3. Deploy to **staging first** (`gtd-api-staging`), point one `mcpServers` block at
   `https://api-staging.getting-things-done.app/mcp`, verify `gtd_list_items` returns `url`.
4. Cut over the local config from the `node dist/index.js` block to the remote URL; keep the stdio
   block available as a fallback.
5. (Later) Option 2 OAuth if Desktop/mobile/no-token-paste UX is wanted.

## Effort estimate

- Option 1 remote `/mcp` mounted in the API, staging-verified: **~½–1 day.**
- Option 2 OAuth on top: **several days**, mostly auth-server correctness and testing.

## Open questions for the user

- Single operator forever, or eventually shared/multi-user? (Decides Option 1 vs. 2.)
- Do you want Claude **Desktop / mobile** access? (Strongest reason to go remote + OAuth.)
- Keep the local stdio binary as a dev/offline fallback, or fully retire it?
