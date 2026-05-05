# mcp-gtd

Local stdio Model Context Protocol server that exposes the GTD public v1 API as four tools. Drop it into Claude Code (or any MCP host) so an LLM can capture, search, and complete inbox items conversationally.

| MCP tool | Endpoint | Purpose |
|---|---|---|
| `create_inbox_item` | `POST /v1/items` | Capture a new inbox item. |
| `search_items` | `GET /v1/items` | List/search with `query`, `status`, `since`, `limit`, `cursor`. |
| `get_item` | `GET /v1/items/:id` | Fetch one item. |
| `complete_item` | `POST /v1/items/:id/complete` | Mark done. |

Full protocol contract for the underlying HTTP API: [`docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md) at the repo root.

## Build

```bash
cd tools/mcp-gtd
npm install
npm run build
chmod +x dist/index.js
```

This produces `dist/index.js` — the binary the MCP host launches.

## Configure

Two env vars, set wherever the MCP host runs the binary:

| Variable | Example | Notes |
|---|---|---|
| `GTD_API_BASE_URL` | `http://localhost:4000/v1` | Local dev. Production: `https://api.getting-things-done.app/v1`. Note the `/v1` suffix — the MCP package speaks v1 only. |
| `GTD_API_TOKEN` | `gtd_…` | Personal API token. Treat like a password. |

### Mint a token (local dev)

1. Start the API server: `cd api-server && npm run dev`.
2. Sign in to the app at <http://localhost:4173> with Google or GitHub.
3. Copy `better-auth.session_token` from DevTools → Application → Cookies → `http://localhost:4173`.
4. Mint:

    ```bash
    curl -s -X POST http://localhost:4000/dev/api-tokens \
        -H 'Content-Type: application/json' \
        -H "Cookie: better-auth.session_token=<paste-cookie>" \
        -d '{"label": "Local MCP"}'
    ```

5. Copy the `plaintext` field from the response and store it. **It is shown exactly once and is not recoverable** — only its sha256 hash is persisted on the server. If you lose it, mint a new one.

### Mint a token (staging / production)

Not yet possible. The `/dev/api-tokens` endpoint is gated by `NODE_ENV !== 'production'` and 404s on deployed environments. Production-safe mint via a settings-page UI is tracked in [issue #19](https://github.com/yuval-yssak/gtd-app/issues/19); until it ships, the MCP can only point at a local API server.

## Wire into Claude Code

Edit `~/.claude.json` (global, applies to every project) or add a project-local `.mcp.json`:

```json
{
    "mcpServers": {
        "gtd": {
            "command": "node",
            "args": ["/absolute/path/to/gtd-api/tools/mcp-gtd/dist/index.js"],
            "env": {
                "GTD_API_BASE_URL": "http://localhost:4000/v1",
                "GTD_API_TOKEN": "gtd_…"
            }
        }
    }
}
```

The path **must be absolute** — Claude Code runs MCP servers from a different working directory. Restart Claude Code, then run `/mcp` to confirm `gtd` is listed with its four tools.

## Wire into other MCP hosts

The package speaks plain stdio MCP — any host that supports the standard transport works. Examples:

- **Cursor**: `~/.cursor/mcp.json` with the same `mcpServers` shape.
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Inspecting manually**: `npx @modelcontextprotocol/inspector node /path/to/dist/index.js` opens an interactive UI for poking at the tools.

## What the tools return

Each tool returns the API response as JSON inside a single text content block. Errors come back as `isError: true` with a `<code>: <status>: <message>` string (e.g. `not_found: 404: item not found`) — the LLM can read and react to them without needing structured access.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server refuses to start: "GTD_API_TOKEN env var is required" | Env vars not propagated by the MCP host. Verify they're inside the `env` block in `mcp.json`, not exported in your shell. |
| Every tool returns `unauthorized: 401` | Token is wrong, copied with whitespace, or revoked. Re-mint. |
| `404` on the create call | `GTD_API_BASE_URL` is missing the `/v1` suffix. |
| Tools don't show up in the host | Path in `mcp.json` isn't absolute, or `dist/index.js` lacks the executable bit. Check the host's MCP log (Claude Code: `~/Library/Logs/Claude/mcp*.log`). |
| Server starts but no items appear in your other tabs after `create_inbox_item` | The API server isn't running, or the SSE connection in those tabs has dropped. Reload the tab to reconnect. |
