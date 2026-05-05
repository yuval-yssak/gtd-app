# mcp-gtd

Local Model Context Protocol server that exposes the GTD public v1 API as four tools:

| Tool | Endpoint |
|---|---|
| `search_items` | `GET /v1/items` |
| `get_item` | `GET /v1/items/:id` |
| `create_inbox_item` | `POST /v1/items` |
| `complete_item` | `POST /v1/items/:id/complete` |

Full protocol contract: `docs/PUBLIC_API.md` at the repo root.

## Build

```bash
cd tools/mcp-gtd
npm install
npm run build
```

This produces `dist/index.js`.

## Configure

Set two env vars wherever the MCP host runs the binary:

```
GTD_API_BASE_URL=http://localhost:4000/v1   # or https://api.getting-things-done.app/v1
GTD_API_TOKEN=gtd_…
```

To mint a token in dev: log in to the app at http://localhost:4173, then from a terminal that has access to your session cookie:

```bash
curl -X POST http://localhost:4000/dev/api-tokens \
    -H 'Content-Type: application/json' \
    -H "Cookie: better-auth.session_token=<paste-from-devtools>" \
    -d '{"label": "Local MCP"}'
```

The response includes a `plaintext` field — paste it into `GTD_API_TOKEN`. The plaintext is shown once and is not recoverable.

## Wire into Claude Code

`~/.config/claude-code/mcp.json`:

```json
{
    "mcpServers": {
        "gtd": {
            "command": "node",
            "args": ["/absolute/path/to/tools/mcp-gtd/dist/index.js"],
            "env": {
                "GTD_API_BASE_URL": "http://localhost:4000/v1",
                "GTD_API_TOKEN": "gtd_…"
            }
        }
    }
}
```

Restart the host. `gtd` should appear in the available MCP servers and the four tools above should be invokable.
