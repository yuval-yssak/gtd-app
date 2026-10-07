# Done MCP server

Lets Claude (or any MCP client) work your Done account in conversation: capture, list, clarify and complete items, and manage routines, people and work contexts.

There are two ways to connect. **Most people want the first one.**

| | Hosted connector (recommended) | Local server (this package) |
|---|---|---|
| Install | Nothing | Clone this repo, Node.js 22+, `npm install` |
| Credentials | Sign in with Google/GitHub in the browser | A personal API token pasted into your client config |
| Works in | claude.ai (web + mobile), Claude Desktop, Claude Code | Claude Desktop, Claude Code (same machine) |
| Accounts | One per connector; add a second connector for a second account | Several in one server (`GTD_API_TOKEN_<LABEL>`), incl. moving items between them (`gtd_reassign`) |

Both expose the same tools and talk to the same `/v1` API, so every change reaches your other devices on their next sync.

## Option 1: Hosted connector (recommended, no install, no token)

The API serves the MCP endpoint itself and runs its own OAuth sign-in. The in-app guide (**Settings → Connect Claude**) shows the URL and copy buttons; the steps are the same as below.

| Environment | Connector URL |
|---|---|
| production | `https://api.getting-things-done.app/mcp` |
| staging | `https://api-staging.getting-things-done.app/mcp` |
| local dev | `http://localhost:4000/mcp` |

**claude.ai or Claude Desktop**

1. Settings → Connectors → **Add custom connector**.
2. Name it `Done`, paste the connector URL, click **Add**.
3. Click **Connect**. Connectors added on claude.ai also work in the Claude mobile app.

On a Claude Team or Enterprise plan, only an owner can add custom connectors (organization settings); members then click **Connect**.

**Claude Code**

```bash
claude mcp add --scope user --transport http done https://api.getting-things-done.app/mcp
```

`--scope user` makes it available in every project; without it the server is tied to the directory you ran the command in. Then, in any Claude Code session, type `/mcp`, select `done` and choose **Authenticate**.

**Sign in (all clients)**

1. A browser window opens. If this browser has no Done session, a **Sign in to Done** page asks you to sign in with Google or GitHub. If it already has one, this step is skipped.
2. The **Authorize access** page lists what Claude may do and every Done account signed in on this browser. Click **Allow** (or **Allow for <email>** when there are several) for the account Claude should use. If yours isn't listed, choose **Use a different account with Google/GitHub**. The provider's account chooser opens, and the page comes back with that account added.
3. Back in Claude, ask *"What's in my Done inbox?"* to confirm. `gtd_me` reports the connected email and environment.

Claude refreshes its access on its own: an access token lasts an hour and the 30-day refresh token rotates on use, so you only sign in again after a month without use. To disconnect, remove the connector in Claude. That only makes Claude forget the tokens: no server-side revoke exists for OAuth grants yet, so the refresh token stays valid until it expires.

Limits of the hosted connector:

- **One account per connector.** For a second account (e.g. work), add a second connector (`done-work`) and click **Allow** for that account on the Authorize page. Each Allow button is bound to its account, so the grant goes to the account you click.
- **No cross-account moves.** `gtd_reassign` needs a token for each account, so it fails with `multi_account_unsupported`. Use the local server for that.
- The OAuth server grants items, routines, people and contexts read/write. It does not grant `reassign` or `webhooks.manage`.

Server code: `api-server/src/routes/mcp.ts` (resource endpoint), `api-server/src/routes/mcpOAuth.ts` + `api-server/src/lib/mcpOAuth.ts` (authorization server). The tool modules are copied into `api-server/src/mcp/`, and a parity test keeps them in step with `mcp-server/src/tools/`. Design notes: [`docs/REMOTE_MCP_PLAN.md`](docs/REMOTE_MCP_PLAN.md).

## Option 2: Local server with a personal API token

Use this when you want several accounts in one server, cross-account moves, or to develop the tools themselves.

### 1. Install + build

```bash
git clone https://github.com/yuval-yssak/gtd-app.git
cd gtd-app/mcp-server
npm install   # the `prepare` hook compiles dist/ automatically
pwd           # the absolute path you will need in step 3
```

The compiled entrypoint is `mcp-server/dist/index.js`. **After editing source, run `npm run build` and restart the MCP client** (Claude CLI / Desktop). A running session holds the old `dist/` process for its lifetime and won't pick up changes until relaunched.

### 2. Mint a personal API token

In the app, go to **Settings → Personal API tokens → Create token**, tick the scopes you need, and copy the value (it starts with `gtd_` and is shown exactly once). Pick the smallest scope set you need. See [`docs/PUBLIC_API.md`](../docs/PUBLIC_API.md) for the full table.

Local dev shortcut (`/dev/*` exists only when `NODE_ENV !== 'production'`):
```bash
curl -X POST http://localhost:4000/dev/api-tokens \
    -H 'Content-Type: application/json' \
    -H "Cookie: better-auth.session_token=<copy-from-devtools>" \
    -d '{"label": "Local MCP", "scopes": ["items.capture","items.read","items.write","routines.read","routines.write","people.read","people.write","contexts.read","contexts.write"]}'
```

### 3. Wire into your MCP client

**`GTD_API_BASE` is required for anything but local dev.** It defaults to `http://localhost:4000`, so without it every call fails against production.

| Environment | `GTD_API_BASE` |
|---|---|
| production | `https://api.getting-things-done.app` |
| staging | `https://api-staging.getting-things-done.app` |
| local dev | `http://localhost:4000` (default) |

#### Claude Code (CLI)

```bash
claude mcp add gtd --scope user \
    --env GTD_API_BASE=https://api.getting-things-done.app \
    --env GTD_API_TOKEN=gtd_... \
    -- node /ABSOLUTE/PATH/TO/gtd-app/mcp-server/dist/index.js
```

Verify with `claude mcp list`; remove with `claude mcp remove gtd`.

#### Claude Desktop / manual config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop), then fully quit and reopen the app:

```json
{
    "mcpServers": {
        "gtd": {
            "command": "node",
            "args": ["/ABSOLUTE/PATH/TO/gtd-app/mcp-server/dist/index.js"],
            "env": {
                "GTD_API_BASE": "https://api.getting-things-done.app",
                "GTD_API_TOKEN": "gtd_..."
            }
        }
    }
}
```

Ask Claude *"Which Done account am I connected to?"* to verify (`gtd_me`).

#### Web-app deep links (`url` field)

Item, routine and person tool responses include a `url`, a direct web-app link (e.g. `https://getting-things-done.app/item/<id>`), so the client can show a clickable link to what it just created or edited. `gtd_batch` returns one per item/routine/person op in its `results`. The web origin is derived from `GTD_API_BASE` (`local` → `http://localhost:4173`, `staging`/`production` → their web hosts). For a self-hosted or preview deployment (`custom` environment), set `GTD_WEB_BASE` to your web-app origin; without it, `custom` deployments omit `url`. Work contexts have no page in the web app, so they carry no `url`.

## Multi-account setup (local server only)

A single Claude session can drive multiple GTD accounts (e.g. personal + work) without restarting. Set one numbered token env var per additional account; the label after `GTD_API_TOKEN_` is what tools refer to (lowercased).

```jsonc
{
    "mcpServers": {
        "gtd": {
            "command": "node",
            "args": ["/Users/yuvalyssak/gtd/mcp-server/dist/index.js"],
            "env": {
                "GTD_API_BASE": "http://localhost:4000",
                "GTD_API_TOKEN": "gtd_…",       // default account (e.g. personal)
                "GTD_API_TOKEN_WORK": "gtd_…"   // additional account, addressable as account="work"
            }
        }
    }
}
```

- `GTD_API_TOKEN` is the **default** account — every tool that omits the `account` arg uses this token.
- `GTD_API_TOKEN_<LABEL>` adds another account whose tools-side label is `<label>` (lowercased). `GTD_API_TOKEN_DEFAULT` is reserved.
- The MCP rejects empty values; any unknown `account` argument surfaces as `GtdApiError(400, 'unknown_account')` with the configured-accounts list in the error body so the model can self-correct.

### Knowing which accounts and environment are connected

`gtd_list_accounts({})` enumerates every account configured in this MCP server (one row per `GTD_API_TOKEN` / `GTD_API_TOKEN_<LABEL>` env var) and echoes the server-wide environment. `gtd_me({ account })` answers the same question for a single account. Both responses include `environment` (`local` / `staging` / `production` / `custom`, derived from `GTD_API_BASE`) and `apiBase` so the model can disambiguate accounts when several `mcpServers` blocks (e.g. `gtd-local`, `gtd-staging`, `gtd-production`) are wired into the same Claude session.

```jsonc
// gtd_list_accounts({}) →
{
    "environment": "production",
    "apiBase": "https://api.getting-things-done.app",
    "accounts": [
        { "account": "default", "userId": "uuid-…", "label": "personal",     "email": "alice@example.com"      },
        { "account": "work",    "userId": "uuid-…", "label": "work-laptop",  "email": "alice@work.example.com" }
    ]
}
```

A revoked or otherwise broken token returns `{ account, error, code? }` for that row instead of failing the whole call, so a single dead token doesn't black out the rest.

### Worked example: move "Buy milk" from personal → work

Mint two tokens in the GTD Settings UI on each account: a `reassign`-scoped token on personal (paste as `GTD_API_TOKEN`), and a `reassign.accept`-scoped token on work (paste as `GTD_API_TOKEN_WORK`). Then ask Claude:

```text
Move task "Buy milk" from my personal GTD into my work account.
```

The model resolves the item id with `gtd_list_items({ q: "Buy milk", account: "default" })`, then calls:

```jsonc
gtd_reassign({
    entityType: "item",
    entityId: "<resolved id>",
    fromAccount: "default",
    toAccount: "work"
})
```

The MCP looks up the work userId via `GET /v1/me` on the recipient token, attaches both bearers (`Authorization` + `X-Reassign-Recipient-Token`), and posts to `/v1/reassign`. No raw UUID ever leaves the env vars.

## Tools

Every tool except `gtd_reassign` accepts an optional `account` arg (default `"default"`). `gtd_reassign` accepts `fromAccount` (defaults to `"default"`) and `toAccount` (required). On the hosted connector only `"default"` (the signed-in account) is valid.

| Tool | Maps to | Scope | Account args |
|---|---|---|---|
| `gtd_capture` | `POST /v1/items` | `items.capture` | `account?` |
| `gtd_list_items` | `GET /v1/items` | `items.read` | `account?` |
| `gtd_get_item` | `GET /v1/items/:id` | `items.read` | `account?` |
| `gtd_update_item` | `PATCH /v1/items/:id` | `items.write` | `account?` |
| `gtd_complete_item` | `POST /v1/items/:id/complete` | `items.write` | `account?` |
| `gtd_trash_item` | `POST /v1/items/:id/trash` | `items.write` | `account?` |
| `gtd_set_brief` | `PUT /v1/items/:id/brief` | `items.write` | `account?` |
| `gtd_generate_brief` | `POST /v1/items/:id/brief/generate` | `items.write` | `account?` |
| `gtd_list_routines` / `gtd_get_routine` | `GET /v1/routines[/:id]` | `routines.read` | `account?` |
| `gtd_create_routine` / `gtd_update_routine` / `gtd_delete_routine` | routines CRUD | `routines.write` | `account?` |
| `gtd_pause_routine` / `gtd_resume_routine` / `gtd_split_routine` | composite gestures | `routines.write` | `account?` |
| `gtd_list_people` / `gtd_get_person` / `gtd_create_person` / `gtd_update_person` / `gtd_delete_person` | people CRUD | `people.{read,write}` | `account?` |
| `gtd_list_work_contexts` / `gtd_get_work_context` / `gtd_create_work_context` / `gtd_update_work_context` / `gtd_delete_work_context` | work-contexts CRUD | `contexts.{read,write}` | `account?` |
| `gtd_reassign` | `POST /v1/reassign` | caller: `reassign`, recipient: `reassign.accept` | `fromAccount?` (default `"default"`), `toAccount` (required) |
| `gtd_batch` | `POST /v1/operations/batch` | union of needed scopes | `account?` |
| `gtd_me` / `gtd_list_accounts` | `GET /v1/me` | any | `account?` / none |

### Why no `gtd_delete_item`?

Items are never hard-deleted through the public surface. Use `gtd_trash_item`, a recoverable soft-delete: the item stays in the in-app Trash and can be restored. `gtd_update_item` rejects `status: "trash"`, and `gtd_batch` rejects `{entityType:'item', opType:'delete'}` with 400. Batch `delete` stays valid for routines, people and work contexts.

## Status×field matrix

`gtd_update_item` enforces this server-side. Caller-supplied fields incompatible with the target status return `400 status_field_violation` with `extra: { status, field }` so the model can self-correct.

`calendarEventId` / `calendarIntegrationId` are never the way to attach an item to an existing Google Calendar event — the sync has already created and linked that item. Find it with `gtd_list_items { calendarEventId }` and update it; a second link is refused with `409 calendar_event_linked` and `extra: { ownerType, ownerId }` naming the row to edit.

To clear an optional field that is already set, pass `null` for it — e.g. `gtd_update_item { id, waitingForPersonId: null }` unsets the person while the item stays `waitingFor`. Omitting a field leaves it unchanged; an empty string is rejected. Not clearable (`400 not_clearable`): `title`, `status`, and the Google Calendar linkage ids (`calendarEventId` / `calendarIntegrationId` / `calendarSyncConfigId`) — detach an item from its calendar event by changing its status instead.

| Status | Allowed status-specific fields |
|---|---|
| `inbox` | (none — title/notes only) |
| `nextAction` | `workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `ignoreBefore` |
| `calendar` | `timeStart`, `timeEnd`, `calendarEventId`, `calendarIntegrationId`, `workContextIds`, `peopleIds` |
| `waitingFor` | `waitingForPersonId`, `peopleIds`, `expectedBy`, `ignoreBefore` |
| `somedayMaybe` | (none) |
| `done` / `trash` | (archival — preserves whatever fields the item carried) |

## Field-completeness guidance

An agent clarifying an item tends to set `status` and stop, which leaves the GTD metadata the method depends on empty. The MCP nudges it in two places, with no per-user memory or prompt needed:

- **Before the write** — the server `instructions` and the `gtd_update_item` description (plus the `energy` / `time` / `workContextIds` / `expectedBy` property descriptions, and the `gtd_create_routine` template guidance) tell the model to send the fields together with the status.
- **After the write** — a `gtd_update_item` response whose item still lacks them carries a `fieldGuidance` block next to the entity:

```jsonc
{
    "_id": "…", "status": "nextAction", "title": "Call plumber", "url": "https://…/item/…",
    "fieldGuidance": {
        "missing": ["energy", "time", "workContextIds"],
        "hint": "Missing: energy, time, workContextIds. A next action is only actionable in the Do phase when it carries all three: …"
    }
}
```

| Status | Fields checked | Notes |
|---|---|---|
| `nextAction` | `energy`, `time`, `workContextIds` | `time: 0` counts as set; an empty `workContextIds` array counts as missing. |
| `waitingFor` | `expectedBy` | The date the delegated outcome is expected. |
| `calendar` | `location` | Checked only when the item carries a `calendarEventId`. The field is Google-Calendar-owned and read-only on the item (`PATCH` rejects it), so the hint tells the agent to set the venue on that Google event; the sync mirrors it back. An unlinked calendar item (no Google Calendar connected) is never flagged — there is nowhere to set it. |

The block is advisory — the write has already succeeded — and is omitted entirely once every checked field is set, so a complete item never carries it. Only `gtd_update_item` is decorated: reads (`gtd_get_item`, `gtd_list_items`) never carry it, so a lookup cannot tempt the model into edits the user did not ask for. Rules live in `src/tools/fieldGuidance.ts`.

## Development

```bash
npm run dev        # tsx watch — picks up GTD_API_TOKEN from your shell env
npm run typecheck  # tsc --noEmit
npm run test       # vitest run
npm run lint:fix   # biome
```

Tests mock `fetch` so they run hermetically — no real server needed.
