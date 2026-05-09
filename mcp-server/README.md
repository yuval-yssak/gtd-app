# gtd-mcp

A local **stdio MCP server** that exposes the GTD `/v1` public API as MCP tools, so Claude (or any MCP client) can capture, list, update, and complete items, manage routines/people/work-contexts, reassign across accounts, and submit atomic batches.

Auth is a personal API token. The server is a thin shim — every write goes through `/v1/*`, hits the same Zod-validated apply pipeline as `/sync/push`, and lands in the operations log so other devices learn about the change on their next sync.

## Setup

### 1. Install + build

```bash
cd mcp-server
npm install
npm run build
```

The compiled entrypoint lives at `mcp-server/dist/index.js`.

### 2. Mint a personal API token

In the GTD app (local dev, staging, or prod), go to **Settings → Personal API tokens** and create one. Copy the plaintext value — it's shown exactly once.

For local dev shortcut:
```bash
curl -X POST http://localhost:4000/dev/api-tokens \
    -H 'Content-Type: application/json' \
    -H "Cookie: better-auth.session_token=<copy-from-devtools>" \
    -d '{"label": "Local MCP", "scopes": ["items.capture","items.read","items.write","routines.read","routines.write","people.read","people.write","contexts.read","contexts.write"]}'
```

Pick the smallest scope set you need — see [`docs/PUBLIC_API.md`](../docs/PUBLIC_API.md) for the full table.

### 3. Wire into your MCP client

#### Claude Code (CLI)

The fastest way is the `claude mcp add` command — it writes the config for you:

```bash
claude mcp add gtd \
    --env GTD_API_BASE=http://localhost:4000 \
    --env GTD_API_TOKEN=gtd_... \
    -- node /Users/yuvalyssak/gtd/mcp-server/dist/index.js
```

Add `--scope user` to register the server globally for your user (default scope is the current project). Verify with `claude mcp list`; remove with `claude mcp remove gtd`.

For staging or production, swap `GTD_API_BASE` to `https://api-staging.getting-things-done.app` or `https://api.getting-things-done.app`.

#### Claude Desktop / manual config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop) or your `claude_code_config` MCP block:

```json
{
    "mcpServers": {
        "gtd": {
            "command": "node",
            "args": ["/Users/yuvalyssak/gtd/mcp-server/dist/index.js"],
            "env": {
                "GTD_API_BASE": "http://localhost:4000",
                "GTD_API_TOKEN": "gtd_..."
            }
        }
    }
}
```

Restart your MCP client after editing the config. The tools should appear under the `gtd` server.

## Multi-account setup

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

Every tool except `gtd_reassign` accepts an optional `account` arg (default `"default"`). `gtd_reassign` accepts `fromAccount` (defaults to `"default"`) and `toAccount` (required).

| Tool | Maps to | Scope | Account args |
|---|---|---|---|
| `gtd_capture` | `POST /v1/items` | `items.capture` | `account?` |
| `gtd_list_items` | `GET /v1/items` | `items.read` | `account?` |
| `gtd_get_item` | `GET /v1/items/:id` | `items.read` | `account?` |
| `gtd_update_item` | `PATCH /v1/items/:id` | `items.write` | `account?` |
| `gtd_complete_item` | `POST /v1/items/:id/complete` | `items.write` | `account?` |
| `gtd_list_routines` / `gtd_get_routine` | `GET /v1/routines[/:id]` | `routines.read` | `account?` |
| `gtd_create_routine` / `gtd_update_routine` / `gtd_delete_routine` | routines CRUD | `routines.write` | `account?` |
| `gtd_pause_routine` / `gtd_resume_routine` / `gtd_split_routine` | composite gestures | `routines.write` | `account?` |
| `gtd_list_people` / `gtd_get_person` / `gtd_create_person` / `gtd_update_person` / `gtd_delete_person` | people CRUD | `people.{read,write}` | `account?` |
| `gtd_list_work_contexts` / `gtd_get_work_context` / `gtd_create_work_context` / `gtd_update_work_context` / `gtd_delete_work_context` | work-contexts CRUD | `contexts.{read,write}` | `account?` |
| `gtd_reassign` | `POST /v1/reassign` | caller: `reassign`, recipient: `reassign.accept` | `fromAccount?` (default `"default"`), `toAccount` (required) |
| `gtd_batch` | `POST /v1/operations/batch` | union of needed scopes | `account?` |

### Why no `gtd_delete_item`?

There's no `DELETE /v1/items/:id` endpoint, and `PATCH` rejects `{status: 'trash'}` — the API has no `/v1` restore route, so trashing through the public surface would create unrecoverable rows. To delete an item programmatically, send a `gtd_batch` with `{entityType:'item', opType:'delete', entityId, snapshot:null}`. Keeping destructive item ops behind the explicit batch tool is intentional safety for an LLM-driven surface.

## Status×field matrix

`gtd_update_item` enforces this server-side. Caller-supplied fields incompatible with the target status return `400 status_field_violation` with `extra: { status, field }` so the model can self-correct.

| Status | Allowed status-specific fields |
|---|---|
| `inbox` | (none — title/notes only) |
| `nextAction` | `workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `ignoreBefore` |
| `calendar` | `timeStart`, `timeEnd`, `calendarEventId`, `calendarIntegrationId`, `workContextIds`, `peopleIds` |
| `waitingFor` | `waitingForPersonId`, `peopleIds`, `expectedBy`, `ignoreBefore` |
| `somedayMaybe` | (none) |
| `done` / `trash` | (archival — preserves whatever fields the item carried) |

## Development

```bash
npm run dev        # tsx watch — picks up GTD_API_TOKEN from your shell env
npm run typecheck  # tsc --noEmit
npm run test       # vitest run
npm run lint:fix   # biome
```

Tests mock `fetch` so they run hermetically — no real server needed.
