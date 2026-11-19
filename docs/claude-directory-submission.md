# Claude connector directory: submission pack

Everything needed to submit the hosted Done connector (`https://api.getting-things-done.app/mcp`) to
Anthropic's connector directory: what the directory requires, where Done stands on each point, the
listing copy to paste into the form, and the steps only the account owner can do.

Requirements were read on 2026-11-19 from Anthropic's docs: [submission](https://claude.com/docs/connectors/building/submission),
[review criteria](https://claude.com/docs/connectors/building/review-criteria),
[MCP requirements](https://claude.com/docs/connectors/building/mcp),
[authentication](https://claude.com/docs/connectors/building/authentication),
[testing](https://claude.com/docs/connectors/building/testing) and the
[Software Directory Policy](https://support.claude.com/en/articles/13145358). Re-read them before
submitting; they change.

## 1. Requirements and status

| Requirement | Status | Where |
|---|---|---|
| Every tool has a `title` | Done | `mcp-server/src/tools/*.ts`; pinned by `toolCatalog.test.ts` |
| Every tool declares `readOnlyHint` and `destructiveHint` | Done (all four hints are sent) | `READS` / `ADDS` / `CHANGES` in `tools/types.ts` |
| No tool mixes reading and writing | Met | reads are `done_list_*`, `done_get_*`, `done_me`; every other tool only writes |
| Tool names ≤ 64 characters | Met | longest is 24; pinned by `toolCatalog.test.ts` |
| Every tool succeeds with valid arguments | Done | `done_reassign` and `done_list_accounts` could never succeed on one signed-in account, so the hosted endpoint no longer lists them or the `account` argument; `mcpEndpoint.test.ts` calls every listed tool |
| Descriptions match behavior, no hidden instructions, no promotion | Met | descriptions reviewed; token env vars no longer mentioned on the hosted surface |
| Helpful errors, not generic ones | Met | `formatError` returns the API's `error`, `code` and `extra` |
| Frugal with tokens | Improved | tool results are now compact JSON; `done_list_items` pages at 50 by default |
| Streamable HTTP over HTTPS | Met | `api-server/src/routes/mcp.ts`, stateless |
| OAuth 2.0 with PKCE S256, discovery via `401` + `WWW-Authenticate` (RFC 9728), authorization server metadata (RFC 8414) | Met | verified against production on 2026-11-19 |
| Dynamic client registration, public clients, refresh-token rotation, `invalid_grant` on a bad refresh | Met | `api-server/src/lib/mcpOAuth.ts` |
| Claude's callback `https://claude.ai/api/mcp/auth_callback` accepted | Met | any https redirect a client registers is accepted |
| Loopback redirect on any port (Claude Code) | Done | `redirectUriIsRegistered` now ignores the port of an http loopback redirect |
| No tokens in the query string | Met | bearer header only |
| Privacy policy URL | Met | https://getting-things-done.app/privacy (covers the MCP server, processors, retention, contact) |
| Public documentation with setup, usage and troubleshooting | Done | https://getting-things-done.app/claude (new public page) |
| At least three working example prompts | Done | five on the `/claude` page; repeated in section 3 |
| Support contact | Met | the address on `/claude` and `/privacy` |
| Own first-party API | Met | the connector calls Done's own `/v1` API |
| No money transfer, media generation, ads, or reading of Claude memory / chat history | Met | none of these exist |
| Test account with sample data | Deferred | only if a reviewer asks; section 4 |
| Paid Claude plan on the submitting account | **Owner action** | section 4 |

Not required by any page read, and not done: token revocation endpoint (removing the connector only
makes Claude forget its tokens), Client ID Metadata Documents (Claude falls back to dynamic
registration), `offline_access` scope.

## 2. Decisions taken (2026-11-19)

1. **Tools are named `done_*` and the server `done-mcp`.** "GTD" is a David Allen Company mark, and
   the repo rule is that it only ever describes the method, never the product. The tools were
   `gtd_*` until this change. The rename is breaking for connections made before it: saved
   per-tool permissions and any prompt or memory that names a `gtd_*` tool must be redone.
   A further rename after listing needs a reviewer-approved listing edit.
2. **Privacy policy covers the connector.** The "AI processing" section now says what Claude reads
   through the connector and that it becomes part of the Claude conversation; the Google API
   Services paragraph, the landing page and the `<noscript>` mirror say calendar items Claude reads
   can include Google Calendar data. `LEGAL_EFFECTIVE_DATE` is 2026-11-19.
3. **No test account for now.** Anthropic's testing page says a basic listing does not need one,
   while the directory policy asks for one. Submit without; if a reviewer asks, see section 4.
4. **Always-ask on writes.** Claude always asks before a tool marked destructive. By Anthropic's
   wording ("modify or delete data") that is every tool that edits existing data, including
   `done_complete_item` and `done_update_item`. Only the four create tools are marked non-destructive.
   Users can still choose "always allow" per tool.
5. **Slug (still open).** The listing slug is permanent once published. Suggested: `done`.

## 3. Listing copy

**Server name** (≤ 100): `Done`

**One-liner** (≤ 200): `Capture, clarify and review your tasks in Done, a productivity app built around David Allen's Getting Things Done® method.`

**Description** (≤ 2,000):

> Done is a personal productivity app for capturing, organising and reviewing your tasks. This
> connector lets Claude work your Done lists in conversation.
>
> Ask Claude to capture something to your inbox, walk through the inbox and turn each capture into
> a next action, a waiting-for, a calendar entry or a someday/maybe, find what fits the time and
> energy you have right now, check what you are still waiting for from other people, or set up a
> recurring routine. Claude can also manage the people and work contexts your items refer to.
>
> Everything Claude changes syncs to the Done web app on all your devices. Items Claude disposes of
> go to the Trash, where you can restore them. Sign in with the Google or GitHub account you use for
> Done; no token or install is needed, and each connector reaches exactly one account.

**Categories** (1–5): Productivity; Task management.

**Documentation URL:** `https://getting-things-done.app/claude`

**Privacy policy URL:** `https://getting-things-done.app/privacy`

**Support contact:** the address shown on `/claude`.

**Icon:** `client/public/icon.svg` (vector), or `client/public/oauth-logo-120.png` (120×120 PNG). The
docs state no size; export a larger PNG from the SVG if the form wants one.

**Use cases / example prompts:**

1. "What's in my Done inbox? Help me clarify each item."
2. "Add 'renew my passport' to my Done inbox, with a note that the current one expires in March."
3. "What am I waiting for from other people, and which of it is overdue?"
4. "I have 30 minutes and not much energy. Which next actions fit?"
5. "Set up a routine that reminds me to water the plants every Sunday."

**Prerequisites:** a free Done account (Google or GitHub sign-in).

**Reads, writes or both:** both.

**Authentication:** OAuth 2.0, dynamic client registration (`oauth_dcr`). No Anthropic-held client
credentials.

**Data handling:** first-party API. No personal health data. No sponsored content.

**Connection URL:** `https://api.getting-things-done.app/mcp`

## 4. Steps only the owner can do

1. **Deploy this change to production** (API and web app) and confirm `GET /version` shows the new
   commit. The directory scans the live endpoint, so the titles and annotations must be live first.
2. **Run every tool once against production**, as the form asks you to confirm. Either add the
   connector on claude.ai and try the five prompts above, or list the tools with the inspector:
   `npx @modelcontextprotocol/inspector --cli https://api.getting-things-done.app/mcp --transport http --method tools/list`
   (it needs a bearer token: a personal API token from Settings works).
3. **Only if a reviewer asks: prepare a test account with sample data.** Done signs in only through Google or GitHub, so the
   reviewer needs a Google account they can sign in with: a dedicated test Google account without
   two-step verification, signed in to Done once. Seed it by connecting Claude to it and asking for a
   handful of inbox items, next actions with energy/time/context, two waiting-for items with a person
   and an expected date, a calendar item, a someday/maybe item, a weekly routine and two work
   contexts. Do not put the credentials in the form; a reviewer emails for them.
4. **Submit** at https://claude.ai/directory/manage → Submit new → MCP connector, from a paid Claude
   account (on Team/Enterprise, an owner). Paste the copy from section 3 and tick the seven
   compliance acknowledgments.
5. **After listing:** tool changes ship by deploying; a tool *name* change needs a listing edit a
   reviewer approves. Tell Anthropic about material changes to tools, data practices or endpoints.
   Escalations: `mcp-review@anthropic.com`.

## 5. Risks to know about

- **Availability.** The API domain sits behind a Cloudflare Worker on the free tier, whose daily
  request limit has taken staging offline before. A listed connector that returns Cloudflare error
  pages fails review and annoys users; consider the paid Workers plan before listing.
- **Cold starts.** Cloud Run scales to zero. Anthropic gives OAuth discovery, registration and token
  requests 10 seconds; a cold start plus a slow database connection can exceed that and shows up as
  an intermittent connection failure.
- **No server-side revoke** for an OAuth grant: after a user removes the connector, its refresh token
  stays valid until it expires (30 days).
