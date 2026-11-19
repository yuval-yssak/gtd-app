# Claude connector directory: submission pack

Record of the hosted Done connector's (`https://api.getting-things-done.app/mcp`) submission to
Anthropic's connector directory: what the directory requires, where Done stands on each point, the
listing copy as submitted, and what to do when the listing or the tools change.

**Status:** submitted 2026-11-19 as **Done – Personal Task Manager** (slug `done-app`), approved the
same day as a *community* connector by an automated review, and published by the owner (a new
listing takes up to an hour to appear). Listing:
https://claude.ai/directory/connectors/done-app. Submission portal:
https://claude.ai/admin-settings/directory/submissions/done-app.

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
| At least three working example prompts | Done | five on the `/claude` page; the three submitted are in section 3 |
| Support contact | Met | the address on `/claude` and `/privacy` |
| Own first-party API | Met | the connector calls Done's own `/v1` API |
| No money transfer, media generation, ads, or reading of Claude memory / chat history | Met | none of these exist |
| Test account with sample data | Not needed | the automated community review did not ask for one; section 4 |
| Paid Claude plan on the submitting account | Met | submitted from the owner's account |

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
5. **Name and slug: Done – Personal Task Manager, `done-app`.** Both "Done" and the slug `done` were
   already taken in the directory. The slug is permanent now that the listing is published. The
   name and slug keep "GTD" and "Getting Things Done" out, for the same reason as the tool names.
   The connector's own `serverInfo` title stays "Done".

## 3. Listing copy (as submitted)

**Server name** (≤ 100): `Done – Personal Task Manager`

**Slug:** `done-app`

**One-liner** (≤ 200): `Capture, clarify and review your tasks in Done: inbox, next actions, waiting-for, calendar and routines, from any Claude chat.`

**Description** (≤ 2,000):

> Done is a personal productivity app for capturing, organising and reviewing everything you have
> committed to. This connector lets Claude work your Done lists in conversation.
>
> Ask Claude to capture a thought to your inbox, or to walk through the inbox with you and turn each
> capture into a next action, a waiting-for, a calendar entry or a someday/maybe. Ask what fits the
> time and energy you have right now, what you are still waiting for from other people and what is
> overdue, or have Claude set up a recurring routine. Claude can also manage the people and work
> contexts your items refer to.
>
> Everything Claude changes syncs to the Done app on all your devices. Claude asks before it changes
> or removes anything that already exists, and items it disposes of go to the Trash, where you can
> restore them.
>
> Sign in with the Google or GitHub account you use for Done. There is no token to copy and nothing
> to install, and each connector reaches exactly one account.
>
> Done follows the Getting Things Done® method. GTD® and Getting Things Done® are registered
> trademarks of the David Allen Company; Done is not affiliated with or endorsed by it.

**Categories:** Productivity.

**Author:** Yuval Yssak (individual developer); author URL `https://getting-things-done.app`.

**Icon:** `client/public/icon.svg`.

**Documentation URL:** `https://getting-things-done.app/claude`

**Support:** `https://getting-things-done.app/claude` (the page carries the support address).

**Privacy policy URL:** `https://getting-things-done.app/privacy`

**Use cases / example prompts.** Chosen from how the connector is really used: turning something
that arrives from outside into tracked commitments. Each prompt creates what it refers to, so all
three work on a new, empty account.

1. **Turn a message into tasks** — "Here's the school's message about the events this year. Put each
   one on my Done calendar and add a task for anything I need to prepare."
2. **Track what you just sent** — "I just emailed the landlord about the repair. Add it to what I'm
   waiting for, and remind me to chase it if there's no answer by Wednesday."
3. **Park until later** — "A friend is visiting from abroad on January 3rd. Remind me to message him
   a few days before, and keep it out of my lists until then."

**Prerequisites:**

> A free Done account (https://getting-things-done.app), created by signing in with Google or
> GitHub. That is the only requirement: the user signs in once while connecting, and the connector
> reaches that one account.

**Reads, writes or both:** read and write.

**Personal health data:** none collected by design; free-text item notes are whatever the user
writes, so the answer given was "other / depends" with that explanation.

**Authentication:** OAuth 2.0, dynamic client registration (`oauth_dcr`). No Anthropic-held client
credentials.

**Data handling:** first-party API. No sponsored content.

**Connection URL:** `https://api.getting-things-done.app/mcp`

All seven policy acknowledgements were ticked. The additional notes told reviewers that the
connector is the same endpoint as Settings → Connect Claude, how the safety annotations are
assigned, that each connection reaches one account with no API keys or tokens in URLs, and that
the example prompts work on an empty account.

## 4. After listing

1. **Tool changes ship by deploying.** The directory reads the live endpoint. Keep every listed tool
   working with valid arguments (`mcpEndpoint.test.ts` walks them all).
2. **A tool *name* change, or a change to the listing copy, needs a listing edit** in the submission
   portal, which a reviewer approves. Tell Anthropic about material changes to tools, data
   practices or endpoints. Contact the directory team at `directory@anthropic.com` (named in the portal;
   `mcp-review@anthropic.com` is the older escalation address); replies to their emails reach a person.
   The portal also shows usage, error rate and directory rank, updated daily.
3. **Verified status** is a separate, stricter review than the community approval Done has
   (https://claude.com/docs/connectors/verification). Apply only if it becomes worth it.
4. **If a reviewer ever asks for a test account:** Done signs in only through Google or GitHub, so
   the reviewer needs a Google account they can sign in with: a dedicated test Google account
   without two-step verification, signed in to Done once. Seed it by connecting Claude to it and
   asking for a handful of inbox items, next actions with energy/time/context, two waiting-for items
   with a person and an expected date, a calendar item, a someday/maybe item, a weekly routine and
   two work contexts. Never put the credentials in a form; send them by email on request.

## 5. Risks to know about

- **Availability.** The API domain sits behind a Cloudflare Worker on the free tier, whose daily
  request limit has taken staging offline before. A listed connector that returns Cloudflare error
  pages fails review and annoys users; consider the paid Workers plan before listing.
- **Cold starts.** Cloud Run scales to zero. Anthropic gives OAuth discovery, registration and token
  requests 10 seconds; a cold start plus a slow database connection can exceed that and shows up as
  an intermittent connection failure.
- **No server-side revoke** for an OAuth grant: after a user removes the connector, its refresh token
  stays valid until it expires (30 days).
