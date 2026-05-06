# GTD Public API (v1)

A small, stable HTTP surface for external integrations and the local MCP server. Distinct from `/sync/*`, which is the internal offline-first protocol used by the first-party client.

## Audience

- **External integrations**: iOS Shortcuts, Raycast, Zapier/n8n, email-to-inbox, custom scripts.
- **Local MCP server**: lets Claude (or another LLM) capture, search, and complete items conversationally.
- **One-off migration scripts** (future): bulk-import from a legacy app.

## Base URL

| Environment | Base URL |
|---|---|
| Production | `https://api.getting-things-done.app/v1` |
| Staging | `https://api-staging.getting-things-done.app/v1` |
| Local dev | `http://localhost:4000/v1` |

## Authentication

All requests must carry a personal API token:

```
Authorization: Bearer gtd_<random>
```

Tokens are user-scoped — every authenticated request resolves to the issuing user, identical to a Better Auth session. Each token is shown **exactly once** at creation; only its SHA-256 hash is persisted.

### Mint, list, revoke (Settings UI)

In any environment (production, staging, local dev), sign in to the app and open **Settings → Personal API tokens**:

1. Click **Create token**, give it a label (e.g. `iOS Shortcut`, `Local MCP`), and click **Create**.
2. Copy the plaintext value from the reveal dialog. **This is the only time it is shown.**
3. To revoke: click **Revoke** on the row. Any integration using that token immediately starts returning `401`.

The list shows each token's label, creation date, and last-used time, plus revocation status for any tokens you have revoked.

A per-user cap of **20 active tokens** is enforced; revoke unused ones before creating new ones. Hitting the cap returns `429 token_cap_reached` from the underlying `POST /account/tokens` endpoint.

### Mint, list, revoke (HTTP)

The Settings UI calls these endpoints under `/account/tokens` (Better Auth session-cookie required):

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/account/tokens` | `{ "label": "..." }` | Returns `{ id, label, createdTs, plaintext }`. |
| `GET` | `/account/tokens` | — | Returns `{ tokens: [...] }` (no plaintext, no hash). |
| `DELETE` | `/account/tokens/:id` | — | Idempotent: revoking an already-revoked token still returns `200`. |

### Local development shortcut

For convenience in local dev, `POST /dev/api-tokens` accepts a session cookie and returns a token without going through the UI. It is gated behind `NODE_ENV !== 'production'` (the `/dev/*` namespace is removed from the app entirely in staging and prod):

```bash
curl -X POST http://localhost:4000/dev/api-tokens \
    -H 'Content-Type: application/json' \
    -H "Cookie: better-auth.session_token=<copy-from-devtools>" \
    -d '{"label": "Local MCP"}'
# → { "id": "...", "label": "Local MCP", "createdTs": "...", "plaintext": "gtd_..." }
```

Use the Settings UI (above) for staging and production.

### Token lifecycle

| Action | Effect |
|---|---|
| Create | Generates a new token, returns the plaintext value once. Caller stores it. |
| Use | Each authenticated call updates `lastUsedTs` (best-effort, async). |
| Revoke | Sets `revokedTs`. Subsequent requests return `401`. The token cannot be re-enabled. |

If you lose a token, revoke it and create a new one. There is no recovery path.

### Failure modes

| Status | Reason |
|---|---|
| `401 Unauthorized` | Missing header, malformed token, unknown token, or token is revoked. |
| `403 Forbidden` | Token is valid but the action is out of scope (reserved — currently all tokens have full v1 scope). |
| `429 Too Many Requests` | Reserved — the API does not currently rate-limit, but clients should retry on `429` with the `Retry-After` header when it ships. |

There is no rate limiting today. Per-token limits will be added before opening the API to third-party use; treat absence as a temporary condition.

## Conventions

- **Content type**: `application/json` for both request and response bodies. UTF-8.
- **Timestamps**: ISO 8601 datetime strings (e.g. `2026-05-04T14:23:00.000Z`). Always UTC.
- **IDs**: client-supplied UUID v4 strings. The server accepts a client-provided `_id` on create; if omitted, the server generates one.
- **Errors**: `{ "error": "<human message>", "code": "<machine slug>" }` with the appropriate HTTP status.
- **Versioning**: this document describes `v1`. Breaking changes ship as `/v2`. Additive changes (new optional fields, new endpoints) may appear in `v1` without a version bump.

## Item shape

The full item shape is `ItemInterface` in `api-server/src/types/entities.ts`. The fields the public API reads or writes:

| Field | Type | Notes |
|---|---|---|
| `_id` | string (UUID) | Stable identifier. |
| `status` | `inbox \| nextAction \| calendar \| waitingFor \| somedayMaybe \| done \| trash` | The public API only creates `inbox` items and only transitions to `done`. |
| `title` | string | Required on create. |
| `notes` | string? | Optional markdown. |
| `createdTs` | string | Server-assigned on create. |
| `updatedTs` | string | Server-assigned on every write. Conflict-resolution anchor. |
| `externalId` | string? | Caller-provided dedupe key. Unique per `(user, externalId)`. |

GTD-specific fields (`workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `ignoreBefore`, `timeStart`, `timeEnd`, calendar linkage, routine linkage) are **read-only** in v1. They surface on `GET` responses but cannot be set or modified through public-API writes. They are owned by the in-app clarify flow and the routine/calendar sync pipelines.

## Endpoints

### `POST /v1/items` — create an inbox item

Captures a single item. Always lands in `inbox` regardless of any status sent.

**Request body**

```json
{
    "title": "Call dentist about Tuesday rescheduling",
    "notes": "Their voicemail said 9am-noon is best.",
    "externalId": "shortcut-2026-05-04-08-12-44"
}
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Non-empty after trim. |
| `notes` | no | Markdown. |
| `externalId` | no | Stable key from the calling system (e.g. an email Message-Id, a Shortcut run UUID, a legacy app ID). Enables exact-match idempotency. |

**Idempotency**

The endpoint is idempotent under two strategies, in this order:

1. **`externalId` provided** — strict idempotency, enforced by a sparse-unique index on `(user, externalId)`. Repeated calls with the same key always return the existing item, even under concurrent posts (the loser is recovered transparently).
2. **`externalId` omitted** — best-effort. The server hashes `(title, notes ?? '')` and looks up inbox items created within the **last 24 hours** with a matching hash. A match returns the existing item; no match creates a new one.

Replays return `201 Created` with the existing item and the response header `X-Idempotent-Replay: true`. New creates return `201` without the header.

The 24h content-dedupe window covers the realistic "double-tap from a Shortcut" / "email retry" case while still letting genuinely recurring captures (e.g. "Take medication" each day) create fresh items. **Caveat:** content-hash dedupe is not collision-proof under concurrent identical posts — there is no unique index, because one would block legitimate recurring captures. If two simultaneous calls with identical `(title, notes)` arrive within milliseconds, you may end up with two rows. Callers that need strict idempotency under concurrency must supply `externalId`.

**Response** — `201 Created`

```json
{
    "_id": "9f2e0a40-7b7b-4f4b-9c3a-3a4f7c8e2b11",
    "user": "0d2a…",
    "status": "inbox",
    "title": "Call dentist about Tuesday rescheduling",
    "notes": "Their voicemail said 9am-noon is best.",
    "externalId": "shortcut-2026-05-04-08-12-44",
    "createdTs": "2026-05-04T14:23:00.000Z",
    "updatedTs": "2026-05-04T14:23:00.000Z"
}
```

**Errors**

| Status | `code` | Meaning |
|---|---|---|
| `400` | `invalid_title` | Title missing or empty after trim. |
| `400` | `invalid_external_id` | `externalId` is not a non-empty string. |
| `401` | `unauthorized` | See auth section. |
| `429` | `rate_limited` | See rate limits. |

---

### `GET /v1/items` — list and search

Returns items owned by the authenticated user.

**Query parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | Case-insensitive **literal** substring match against `title` and `notes`. Regex metacharacters are escaped — `q=a.b` matches the literal string "a.b", not "aXb". |
| `status` | `ItemStatus` or comma-separated list | all except `trash` | e.g. `status=inbox` or `status=nextAction,calendar`. |
| `since` | ISO datetime | — | Only items with `updatedTs > since`. Useful for polling. |
| `limit` | int | 50 | Max 200. |
| `cursor` | string | — | Opaque cursor from a previous response's `nextCursor`. |

**Response** — `200 OK`

```json
{
    "items": [
        { "_id": "…", "status": "inbox", "title": "…", "createdTs": "…", "updatedTs": "…" }
    ],
    "nextCursor": "eyJ1cGRhdGVkVHMiOiIyMDI2L…"
}
```

`nextCursor` is present when more results exist. Pass it back as `cursor=` to fetch the next page. Cursors are opaque (do not parse them); they encode the last item's `(updatedTs, _id)` pair.

Sorted by `updatedTs DESC, _id DESC`. Stable across concurrent writes — newly written items always appear on the first page.

---

### `GET /v1/items/:id` — fetch one item

**Response** — `200 OK` with the full item, or `404 Not Found` (`code: not_found`) if the item doesn't exist or belongs to another user. (We deliberately do not distinguish "exists but not yours" from "doesn't exist" — that would leak ID existence.)

---

### `POST /v1/items/:id/complete` — mark as done

Transitions any item to `done` and bumps `updatedTs`. Idempotent: completing an already-`done` item returns `200` and the unchanged item.

**Request body**: empty (or `{}`).

**Response** — `200 OK` with the updated item.

**Errors**

| Status | `code` | Meaning |
|---|---|---|
| `404` | `not_found` | Item doesn't exist for this user. |
| `409` | `not_completable` | Item is in `trash` (un-trash via the app first). |

**Side effects**

- For a `calendar` item linked to Google Calendar (`calendarEventId` set), the existing GCal pushback path runs as it would for an in-app completion (the linked event is updated/removed per current routine/calendar rules).
- A `routine`-generated item completing may trigger generation of the next instance, identical to the in-app flow.
- An `OperationInterface` is logged with `deviceId = "api:<tokenId>"` so all the user's devices pull the change on their next sync.

## How the public API relates to `/sync`

Every public-API write is converted into the same `OperationInterface` snapshot the in-app sync layer uses, then handed to the same `applyEntitySnapshotOp` helper (`api-server/src/routes/sync.ts`). Consequences:

- Live clients receive an SSE `update` event immediately.
- Closed clients with web push enabled receive a notification.
- The operation is in the operations log, so every other device pulls it on the next `/sync/pull`.
- Calendar pushback fires for completes on calendar-linked items.

There is no second write path, no risk of the sync log diverging from REST writes, and no special-case purge logic. Public-API ops are subject to the same purge floor as device ops.

## Local MCP server

A minimal Model Context Protocol server lives at `tools/mcp-gtd/` (planned). It exposes four tools that wrap the v1 API one-to-one:

| MCP tool | Calls |
|---|---|
| `search_items({ query?, status?, limit? })` | `GET /v1/items` |
| `get_item({ id })` | `GET /v1/items/:id` |
| `create_inbox_item({ title, notes?, externalId? })` | `POST /v1/items` |
| `complete_item({ id })` | `POST /v1/items/:id/complete` |

### Configuration

The MCP server reads its config from environment variables:

```
GTD_API_BASE_URL=https://api.getting-things-done.app/v1
GTD_API_TOKEN=gtd_…
```

### Wiring into Claude Code

Add to `~/.config/claude-code/mcp.json` (or your editor's MCP config):

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

### Why these tools and not more

The MCP scope is deliberately read + capture + complete. Clarify (inbox → nextAction with energy/time/contexts) is *not* exposed because:

- An LLM mis-clarifying buries items in a backlog the user no longer scans.
- Energy/time/context selection is value-laden; the user should make those calls.
- The existing in-app clarify UI is faster than narrating field-by-field through chat.

When clarify is added later, it should ship under a separate tool (`clarify_inbox_item`) and a separately-scoped token, so users can grant capture-only access without granting clarify.

## Reserved surface (not implemented)

These are noted so the URL space stays clean.

| Path | Reserved for |
|---|---|
| `POST /v1/items/bulk` | Migration import — accepts `{ items: [...], chunkSize? }` with `externalId` upsert. |
| `PATCH /v1/items/:id` | Clarify (inbox → nextAction with metadata). Will require a clarify-scoped token. |
| `POST /v1/webhooks` | Outbound webhooks for "new inbox item" triggers. |
| `GET /v1/people`, `GET /v1/work-contexts` | Read-only listing of related entities, needed by clarify. |

## Implementation notes (for the API server)

These are not part of the public contract, but help reviewers map the docs onto code:

- New router: `api-server/src/routes/v1Items.ts`, mounted in `index.ts` at `.route('/v1', v1Router)` where `v1Router` aggregates item routes (and any future v1 routes).
- New DAO: `apiTokensDAO` for the `apiTokens` collection. Schema: `{ _id, user, tokenHash (sha256 hex), label, createdTs, lastUsedTs, revokedTs? }`. Unique index on `tokenHash`.
- New middleware: `authenticateBearer` parses `Authorization: Bearer gtd_<…>`, hashes, looks up by `tokenHash`, rejects if `revokedTs` set. On success it sets `c.set('session', { user: { id: token.user } })` so handlers can be agnostic about the auth source.
- Content-hash dedupe: `sha256(title + ' ' + (notes ?? ''))`, stored as `contentHash` on inbox items, queried with `{ user, status: 'inbox', contentHash, createdTs: { $gte: 24h ago } }`. Index on `(user, status, contentHash)`.
- `externalId`: stored as a top-level field on `ItemInterface`. Sparse unique index on `(user, externalId)`. Add to the type with a JSDoc comment noting it is set only via the public API.
- Each public-API mutation builds an `OperationInterface` (`deviceId = "api:<tokenId>"`, server-generated `ts`, full snapshot) and calls `applyEntitySnapshotOp` plus `notifyUserViaSse` / `notifyViaWebPush` / `maybePushToGCal` exactly as `/sync/push` does. The handler does not duplicate that logic — it imports the helpers.
