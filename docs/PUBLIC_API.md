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

### Token scopes

Each token carries a `scopes` array — the capabilities it is permitted to exercise. Issuing tokens with the smallest scope set is the right hygiene. The Settings UI lets you tick the capabilities at mint time; the HTTP endpoint accepts a `scopes` field on `POST /account/tokens`.

| Scope | Allows |
|---|---|
| `items.capture` | `POST /v1/items`, `POST /v1/items/bulk` |
| `items.read` | `GET /v1/items`, `GET /v1/items/:id` |
| `items.write` | `PATCH /v1/items/:id`, `POST /v1/items/:id/complete`, `POST /v1/items/:id/trash` |
| `routines.read` | `GET /v1/routines`, `GET /v1/routines/:id` |
| `routines.write` | `POST /v1/routines`, `PATCH /v1/routines/:id`, `DELETE /v1/routines/:id`, plus the composite gestures (`/pause`, `/resume`, `/split`) |
| `people.read` | `GET /v1/people`, `GET /v1/people/:id` |
| `people.write` | `POST /v1/people`, `PATCH /v1/people/:id`, `DELETE /v1/people/:id` |
| `contexts.read` | `GET /v1/work-contexts`, `GET /v1/work-contexts/:id` |
| `contexts.write` | `POST /v1/work-contexts`, `PATCH /v1/work-contexts/:id`, `DELETE /v1/work-contexts/:id` |
| `reassign` | `POST /v1/reassign` — moves entities OUT of this user to another. |
| `reassign.accept` | Authorises another user's `reassign`-scoped token to move entities INTO this user. Sent in `X-Reassign-Recipient-Token`; never carried by the calling bearer. |
| `webhooks.manage` | `POST /v1/webhooks`, `GET /v1/webhooks`, `DELETE /v1/webhooks/:id` |
| `claude.assist` | `POST /v1/claude/assist`, `POST /v1/claude/assist/apply` — the "Clarify with Claude" agent. A distinct scope (not `items.write`) so the agent surface is grantable and auditable independently of broad write access. |

Default scopes when omitted: `['items.capture', 'items.read']` (capture-and-list — the minimum useful set for an inbox-only Raycast/iOS Shortcut style integration).

`POST /v1/operations/batch` requires the **union** of scopes for every op in the batch. Missing any returns `403` with `code: forbidden_scope` and the offending `requiredScope` named in the response — no partial writes.

A request hitting an endpoint that the token's scopes do not cover returns `403` with `code: forbidden_scope`. Pre-scopes tokens (issued before this surface shipped) are backfilled to the default set on first authenticated use.

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
| `403 Forbidden` | Token is valid but the action is out of scope. The response includes `code: forbidden_scope` and the `requiredScope` that was missing. |
| `429 Too Many Requests` | Per-token rate limit exceeded. The response carries a `Retry-After: <seconds>` header — back off and retry after that interval. |

### Rate limits

Each token has two independent buckets that refill continuously over a one-minute window:

| Bucket | Endpoints | Capacity |
|---|---|---|
| Write | All `POST` / `PATCH` / `DELETE` under `/v1/*` (items, routines, people, work-contexts, composite gestures, reassign, operations/batch) | **60 / minute** |
| Read | All `GET` under `/v1/*` (items, routines, people, work-contexts) | **600 / minute** |

A separate **30 / minute per-IP** bucket caps unauthenticated traffic so a flood of bad-credential calls cannot exhaust server resources before reaching the auth check.

Hitting a bucket returns:

```json
{ "error": "Rate limit exceeded. Slow down and retry after a brief pause.", "code": "rate_limited" }
```

with `Retry-After: <seconds>` in the response headers. Read and write buckets are independent — a hot read loop will not starve writes from the same token.

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
| `status` | `inbox \| nextAction \| calendar \| waitingFor \| somedayMaybe \| done \| trash` | `POST /v1/items` always lands in `inbox`; transitions are driven by `PATCH /v1/items/:id` (any matrix-allowed transition except `trash`), `POST /v1/items/:id/complete` (→ `done`), and `POST /v1/items/:id/trash` (→ `trash`, recoverable). |
| `title` | string | Required on create. |
| `notes` | string? | Optional markdown. |
| `createdTs` | string | Server-assigned on create. |
| `updatedTs` | string | Server-assigned on every write. Conflict-resolution anchor. |
| `externalId` | string? | Caller-provided dedupe key. Unique per `(user, externalId)`. |

GTD-specific fields (`workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `ignoreBefore`, `timeStart`, `timeEnd`, `waitingForPersonId`, calendar linkage) are now **writable** through `PATCH /v1/items/:id` and `POST /v1/operations/batch` — subject to the status×field matrix (e.g. `expectedBy` / `ignoreBefore` are valid on `nextAction` / `waitingFor` / `somedayMaybe` / `done` / `trash`; `timeStart`/`timeEnd` only on `calendar` / `done` / `trash`; `waitingForPersonId` is optional even on `waitingFor`). Server-managed fields (`routineId`, `contentHash`, `lastPushedToGCalTs`, `lastSyncedFromGCalTs`, `lastSyncedNotes`, `externalId`) remain off-limits — caller-supplied values are rejected with `400 forbidden_field`.

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

### `POST /v1/items/bulk` — migration import

Capture many inbox items in one round-trip. **`externalId` is required on every item** — re-running the import after a partial failure must be idempotent, and that requires a stable per-item key. Items without `externalId` are reported as `failed` but do not abort the batch.

**Request body**

```json
{
  "items": [
    { "title": "Buy oat milk", "externalId": "legacy-42" },
    { "title": "Reply to Sam", "notes": "thread://abc", "externalId": "legacy-43" }
  ],
  "chunkSize": 100
}
```

**Limits**

| Limit | Value | Failure |
|---|---|---|
| Items per request | 5,000 | `413` `too_many_items` |
| Chunk size | clamped to 1–500 (default 100) | silently clamped |

The endpoint counts as a **single write** against the per-token rate limit.

**Response** — always `200 OK` with a per-item result, even when individual items fail validation. Whole-request errors (oversize, missing body) return `4xx`.

```json
{
  "results": [
    { "externalId": "legacy-42", "status": "created", "_id": "uuid-…" },
    { "externalId": "legacy-43", "status": "replayed", "_id": "uuid-…" },
    { "externalId": "legacy-44", "status": "failed", "code": "invalid_title", "error": "title must be a non-empty string" }
  ],
  "counts": { "created": 1, "replayed": 1, "failed": 1 }
}
```

**Idempotency** — re-running the same batch is safe: every successful row in the second run reports `replayed` with the same `_id` as the first.

---

### `PATCH /v1/items/:id` — full-surface update

Updates any user-settable field on an existing item. **Requires the `items.write` scope.**

Allowed fields (all optional except at least one must be present): `title`, `notes`, `status`, `workContextIds`, `peopleIds`, `waitingForPersonId`, `energy`, `time`, `focus`, `urgent`, `expectedBy`, `ignoreBefore`, `timeStart`, `timeEnd`, `calendarEventId`, `calendarIntegrationId`, `calendarSyncConfigId`.

Status transitions are no longer restricted to `inbox` as the source — any matrix-allowed transition is accepted. Field combinations must satisfy the status×field matrix (e.g. `nextAction` + `timeStart` returns `400 status_field_violation`). The matrix is single-source-of-truth in `api-server/src/schemas/operations/item.ts`.

**Two exceptions to the broadened surface:**

- `{status: 'trash'}` is rejected with `409 invalid_transition` — trashing has a single dedicated entry point, [`POST /v1/items/:id/trash`](#post-v1itemsidtrash--soft-delete-recoverable) (recoverable soft-delete). Funnelling it through one endpoint keeps the disposal semantics (idempotency, routine advancement) in one place.
- Server-managed fields are rejected up front with `400 forbidden_field`: `_id`, `user`, `createdTs`, `updatedTs`, `routineId`, `contentHash`, `externalId`, and the four sync-anchor fields (`lastPushedToGCalTs`, `lastSyncedFromGCalTs`, `lastSyncedNotes`).

**Stale-field sanitization.** When a status transition makes an existing-row field invalid (e.g. moving a calendar item to `inbox` makes its `timeStart` no longer valid), the server strips the *existing* field automatically. Caller-supplied incompatible fields are NOT silently stripped — they surface as `status_field_violation` so client bugs are visible.

**Errors**

| Status | `code` | Meaning |
|---|---|---|
| `400` | `invalid_body` | Request body is not a JSON object. |
| `400` | `empty_body` | Body had no fields. |
| `400` | `forbidden_field` | Body included a server-managed field. |
| `400` | `invalid_operation` | Zod schema rejected a field type or shape. The response carries `path: [field]` to pinpoint the offender. |
| `400` | `status_field_violation` | A caller-supplied field is incompatible with the target status under the matrix. The response carries `extra: { status, field }`. |
| `403` | `forbidden_scope` | Token lacks `items.write`. |
| `404` | `not_found` | Item doesn't exist for this user. |
| `409` | `invalid_transition` | Caller asked for `{status: 'trash'}`. |

**Response** — `200 OK` with the updated item.

---

### `/v1/people` and `/v1/work-contexts` — full CRUD

Catalogues of the user's contacts and work-context tags. Pagination and `since` semantics mirror `GET /v1/items`. All endpoints scrub the internal `user` field from responses.

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/v1/people` | `people.write` | Body: `{ name, email?, phone?, externalCalendarId?, notes? }`. Returns 201. Server-managed fields (`_id`, `user`, `createdTs`, `updatedTs`) rejected with `forbidden_field`. |
| `GET` | `/v1/people` | `people.read` | `?limit=` (default 100, max 500), `?cursor=`, `?since=ISODateTime`. |
| `GET` | `/v1/people/:id` | `people.read` | 404 if missing or not yours. |
| `PATCH` | `/v1/people/:id` | `people.write` | Same allowlist as POST. Empty body → `400 empty_body`. |
| `DELETE` | `/v1/people/:id` | `people.write` | Idempotent: missing row returns 200 with `alreadyDeleted: true`. **Does not cascade** — references from items (`peopleIds`, `waitingForPersonId`) are left dangling and the client renders them as missing. |
| `POST` | `/v1/work-contexts` | `contexts.write` | Body: `{ name }`. Otherwise mirrors `/v1/people`. |
| `GET` | `/v1/work-contexts` | `contexts.read` | Same pagination shape. |
| `GET` | `/v1/work-contexts/:id` | `contexts.read` | |
| `PATCH` | `/v1/work-contexts/:id` | `contexts.write` | |
| `DELETE` | `/v1/work-contexts/:id` | `contexts.write` | Idempotent. |

---

### `/v1/routines` — full CRUD plus composite gestures

Routines are recurring task templates. They have a richer shape than items / people / workContexts (RRULE, template, exception list, calendar-link metadata) — the route layer leans on the operations schema (`RoutineSnapshotSchema` in `api-server/src/schemas/operations/routine.ts`) for field-level validation.

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/v1/routines` | `routines.write` | Body shape: `{ title, routineType: 'nextAction' \| 'calendar', rrule, template: RoutineItemTemplate, active: boolean, ... }`. Returns 201. |
| `GET` | `/v1/routines` | `routines.read` | Standard pagination. |
| `GET` | `/v1/routines/:id` | `routines.read` | |
| `PATCH` | `/v1/routines/:id` | `routines.write` | Writable fields: `title`, `routineType`, `rrule`, `template`, `active`, `startDate`, `calendarItemTemplate`, `calendarEventId`, `calendarIntegrationId`, `calendarSyncConfigId`. Server-managed fields (`splitFromRoutineId`, `lastGeneratedDate`, `routineExceptions`, `lastPushedToGCalTs`, `lastSyncedNotes`) and deprecated fields (`triggerMode`, `afterCompletionDelayDays`) are rejected with `forbidden_field`. |
| `DELETE` | `/v1/routines/:id` | `routines.write` | Idempotent. The pre-delete snapshot is hydrated from DB and logged so other devices can apply the cascade locally. |
| `POST` | `/v1/routines/:id/pause` | `routines.write` | Composite: trashes future open items + flips `active=false`. GCal cap-with-UNTIL fires downstream. |
| `POST` | `/v1/routines/:id/resume` | `routines.write` | Composite: flips `active=true` and stamps `startDate=tomorrow` so the on-device generator starts a fresh series. |
| `POST` | `/v1/routines/:id/split` | `routines.write` | Composite: caps the head with UNTIL, deletes future calendar items, creates a new tail routine. Body: `{ splitDate: 'YYYY-MM-DD', tailEdits?: { title?, rrule?, ... } }`. Returns 201 with `{ head, tail }`. |

**Calendar-routine seeding limitation.** The server-side composite split caps the head and creates the tail routine, but does NOT materialize the tail's first calendar items — that lives client-side in `generateCalendarItemsToHorizon`. A pure-API consumer will see new items appear only after a connected client syncs. The GCal master event is still created via the existing `handleRoutinePush` pushback. This matches the in-app split gesture's contract.

---

### `POST /v1/reassign` — move an entity to another user

Moves an **item** or **routine** from the calling token's user (`fromUserId`) to a different user. **Two-token consent gesture**: the caller's `reassign`-scoped token signs the request, AND the recipient's `reassign.accept`-scoped token rides along in `X-Reassign-Recipient-Token`. Both tokens must be live, distinct, and the recipient must belong to `toUserId`.

This is the bearer-token analog of `/sync/reassign`'s device-multi-session check. A stolen `reassign` token cannot dump items into an arbitrary account — the attacker would also need a live `reassign.accept` token from the destination user.

**People and workContexts are not reassignable.** When the moved item/routine carries `peopleIds`, `workContextIds`, or `waitingForPersonId`, the server resolves each ref into the recipient's account:

1. Reuse an existing record where it can — person matched email-first then name (both exact, case-sensitive); workContext matched by exact, case-sensitive name.
2. Otherwise, create a new mirror record under the recipient with the source row's display fields (`name`, plus `email`/`phone`/`notes`/`externalCalendarId` for people).

The source user's people and workContexts are never modified or deleted by a reassign — they keep their address book and context list intact. Stale ids (refs pointing at records the source user no longer owns) are passed through unchanged.

**Request**

```http
POST /v1/reassign
Authorization: Bearer <A-token>           # scope: reassign
X-Reassign-Recipient-Token: <B-token>     # scope: reassign.accept; user === toUserId
Content-Type: application/json

{
    "entityType": "item",
    "entityId": "uuid-…",
    "toUserId": "<B userId>",
    "editPatch": { "title": "Optional rename ride-along" }
}
```

| Field | Required | Notes |
|---|---|---|
| `entityType` | yes | `item` or `routine`. (`person` / `workContext` are intentionally rejected — see auto-relink above.) |
| `entityId` | yes | Target row, must belong to the calling user. |
| `toUserId` | yes | Must differ from the calling user; must equal `X-Reassign-Recipient-Token`'s user. |
| `editPatch` | no | Whitelisted edits applied atomically (item path); see `ReassignItemEditPatch` in `api-server/src/lib/reassignEntity.ts`. |
| `editRoutinePatch` | no | Routine equivalent. |
| `targetCalendar` | when item is calendar-linked | `{ integrationId, syncConfigId }` for the destination GCal. |

**Errors**

| Status | `code` | Meaning |
|---|---|---|
| `400` | `invalid_entityType` / `invalid_entityId` / `invalid_toUserId` | Body validation. |
| `400` | `same_user` | `toUserId` equals the calling token's user. |
| `400` | `recipient_consent_required` | `X-Reassign-Recipient-Token` header is missing. |
| `400` | `same_token` | Recipient header carries the same token row as the caller. |
| `400` | `validation_failed` | The reassigned snapshot fails strict-mode Zod / status×field validation, OR `entityType` is `person`/`workContext` (these are not reassignable). The source row is preserved (no torn move). |
| `401` | `invalid_recipient_token` | Recipient header value did not resolve to a live token. |
| `403` | `forbidden_scope` | Caller token lacks `reassign`. |
| `403` | `recipient_token_mismatch` | Recipient token's user does not equal `toUserId`. |
| `403` | `recipient_scope_missing` | Recipient token lacks `reassign.accept`. |
| `404` | `reassign_failed` | Entity not owned by the calling user, or routine-generated item (which cannot be reassigned). |
| `502` | `reassign_failed` | GCal create-on-target failed; nothing was persisted. |

**Fan-out parity.** A reassign now flows through `applyAndPublishOperation` for both legs — a delete on `fromUserId` and a create on `toUserId`. SSE, web push, GCal pushback, and webhook deliveries fire on BOTH user channels, so external integrations see cross-account moves with the same fidelity as any other write. Both ops carry `deviceId: api:<tokenId>` for audit attribution. Strict-mode validation runs ahead of the source delete, so an invalid snapshot can't leave a torn state.

---

### `GET /v1/me` — caller identity

Returns the userId behind the authenticated bearer token, the token's human label, and the user's email. Any minted scope grants access — this exposes nothing beyond what `/v1/items` already implies about the caller.

**Response**

```json
{ "userId": "uuid-…", "label": "iOS Shortcut", "email": "alice@example.com" }
```

`email` is `""` if the underlying user row has been deleted out from under a still-valid token (defensive — should not occur in practice). The primary consumer is the local MCP server, which uses this to translate an account-label slug → userId so the model never has to know raw Better Auth UUIDs (see "Multi-account workflows" below).

| Status | Meaning |
|---|---|
| `200` | Authenticated, identity returned. |
| `401` | Missing / malformed / unknown / revoked token. |

---

### `POST /v1/operations/batch` — heterogeneous batch writes

Submit an array of primitive ops in one request. Use this when an integration needs to land several related changes atomically — e.g. create a workContext and several items that reference it.

**Request body**

```json
{
    "ops": [
        { "entityType": "workContext", "opType": "create", "entityId": "uuid-1", "snapshot": { "_id": "uuid-1", "user": "...", "name": "near phone", "createdTs": "...", "updatedTs": "..." } },
        { "entityType": "item",        "opType": "create", "entityId": "uuid-2", "snapshot": { "_id": "uuid-2", "user": "...", "status": "inbox", "title": "Call mom", "createdTs": "...", "updatedTs": "..." } }
    ]
}
```

Each op carries `entityType`, `opType` (`create` / `update` / `delete`), `entityId`, and a full `snapshot` (or `null` for delete). The server re-stamps `snapshot.user` to the calling token's user before persisting.

> **Item hard-delete is not permitted here.** An op of `{ entityType: 'item', opType: 'delete' }` is rejected with `400 invalid_op_shape` because a hard delete physically removes the row and is unrecoverable. To dispose of an item use [`POST /v1/items/:id/trash`](#post-v1itemsidtrash--soft-delete-recoverable) — a recoverable soft-delete. `opType: 'delete'` remains valid for `routine`, `person`, and `workContext` ops (their deletes hydrate a pre-delete snapshot into the op log for cascade replay).

**Atomicity guarantees**

- **Scope:** the route computes the union of scopes the ops need (per `scopeForOp` in `api-server/src/routes/v1/operations.ts`) and rejects with `403 forbidden_scope` *before any write* if any are missing. The response includes `requiredScope` (the first missing) and `allRequiredScopes`.
- **Validation:** every op is validated up-front (Zod + status×field matrix). If any fails, the batch rejects with `400` and the corresponding code (`invalid_operation` / `status_field_violation`) — no partial writes.
- **NOT atomic against mid-flight Mongo failures.** Once validation passes, ops are persisted in parallel; a Mongo outage between two ops can leave the batch half-applied. This is the same caveat that has always existed on `/sync/push` (the same pipeline backs both surfaces).

**Limits.** 500 ops per request (returns `400 too_many_ops` over). Batch counts as a single write against the per-token rate limit.

**Response** — `200 OK` with `{ ok: true, count: <number-of-ops> }` on success, or one of the structured error shapes above.

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

---

### `POST /v1/items/:id/trash` — soft-delete (recoverable)

Moves an item to `status: 'trash'` and bumps `updatedTs`. This is the **only** way to dispose of an item via the public API, and it is **recoverable** — the item stays in the collection and surfaces in the in-app Trash view, where the user can restore it. There is no item hard-delete on the public surface (`/v1/operations/batch` rejects `{entityType:'item', opType:'delete'}`; `PATCH` rejects `{status:'trash'}`). Idempotent: trashing an already-trashed item returns `200` with `X-Idempotent-Replay: true` and the unchanged item.

Requires the `items.write` scope.

**Request body**: empty (or `{}`).

**Response** — `200 OK` with the updated (trashed) item.

**Errors**

| Status | `code` | Meaning |
|---|---|---|
| `404` | `not_found` | Item doesn't exist for this user. |

**Side effects**

- Trashing a `routine`-generated item advances the series (next instance is generated), mirroring the in-app `clarifyToTrash` flow.
- An `OperationInterface` (`opType: 'update'`, not `delete`) is logged with `deviceId = "api:<tokenId>"` so all the user's devices pull the trashed state on their next sync.

---

## Claude assist (Lane A)

The "Clarify with Claude" agent. `POST /v1/claude/assist` runs a bounded, single-turn Claude tool-use loop over the item's GTD context and returns a **reviewable proposal** — it never writes. `POST /v1/claude/assist/apply` redeems a short-lived signed `executeToken` from that proposal to perform the approved write through the normal operations log (so undo / cross-device sync / Google Calendar pushback all apply). Both endpoints require the **`claude.assist`** scope.

**Ownership rule:** the agent always acts as the account that **owns the item** (`item.user`), never the active session. For a bearer token the caller must own the target item; otherwise the request returns `404 not_found` (existence is not leaked across accounts).

### `POST /v1/claude/assist` — clarify an item

**Request body**

```json
{ "itemId": "uuid-…", "instruction": "clarify this into a next action" }
```

`instruction` is optional free text. The agent may read the user's people, work contexts, items, and (if a Google Calendar is connected) calendar events to ground its proposal. No write happens here.

**Response** (`200`)

```json
{
    "summary": "Turn this into a next action to follow up with Dana.",
    "proposedItemPatch": { "title": "Follow up with Dana on the deck", "status": "nextAction", "energy": "low" },
    "proposedSideEffects": [
        { "kind": "itemPatch", "preview": "Follow up with Dana on the deck", "executeToken": "<signed token>" }
    ]
}
```

`proposedItemPatch` (optional) is the change the agent suggests; each `proposedSideEffect` carries a human `preview` and a short-lived `executeToken` the client redeems on confirm. The client may **edit the patch values** before applying — the same token still applies. Changing the *target* (a field the proposal didn't authorize) requires re-running assist.

| Status | `code` | Meaning |
|---|---|---|
| `200` | — | Proposal returned. |
| `400` | `invalid_request` | `itemId` missing. |
| `402` | `daily_spend_cap_reached` | Per-user daily Claude budget reached; no call was made. |
| `403` | `forbidden_scope` | Token lacks `claude.assist`. |
| `404` | `not_found` | Item doesn't exist or isn't owned by the caller. |
| `502` | `agent_error` | The model call failed. |
| `504` | `agent_timeout` | The agent exceeded its wall-clock budget. |

### `POST /v1/claude/assist/apply` — redeem an executeToken

**Request body**

```json
{ "executeToken": "<token from a proposal>", "patch": { "title": "My edited title", "status": "nextAction" } }
```

`patch` is the (possibly edited) values to write. Every field must be within the token's authorized set **and** the agent-proposable allowlist — calendar-owned and identity fields can never be written this way. The write flows through the operations log (`deviceId = "api:<tokenId>"`).

**Response** (`200`)

```json
{ "applied": true, "item": { "id": "uuid-…", "status": "nextAction", "title": "My edited title" } }
```

| Status | `code` | Meaning |
|---|---|---|
| `200` | — | Applied. |
| `400` | `invalid_request` | `executeToken` missing, or the patch is empty. |
| `400` | `execute_token_target_mismatch` | The patch changes a field the approval didn't authorize — re-run assist. |
| `400` | `invalid_execute_token` | Token tampered or malformed. |
| `400` | `invalid_operation` | The resulting item failed validation (e.g. a field invalid for the new status). |
| `403` | `forbidden` | The token was minted for a different account. |
| `404` | `item_not_found` | The item no longer exists. |
| `410` | `execute_token_expired` | The approval expired (~10 min TTL) — re-run assist. |

---

## Webhooks

Subscribe a URL to receive signed POST notifications when items change. Useful for Zapier / n8n / Make integrations that want push events instead of polling. Requires the `webhooks.manage` scope on the calling token.

### Endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/v1/webhooks` | `{ url, events: WebhookEvent[] }` | Returns `{ id, url, events, createdTs, secret }`. **Secret is shown exactly once.** |
| `GET` | `/v1/webhooks` | — | Returns `{ subscriptions: [...] }`. Secret is never echoed. |
| `DELETE` | `/v1/webhooks/:id` | — | Hard-deletes the subscription. Already-enqueued deliveries remain in the audit log. |

**Limits**: per-user cap of 10 active subscriptions. Hitting it returns `429 subscription_cap_reached`.

### Event types

| Event | Fires when |
|---|---|
| `item.created` | A new `inbox` item is captured (via `POST /v1/items` or `POST /v1/items/bulk`). |
| `item.completed` | An item transitions to `done` (via `POST /v1/items/:id/complete`). |

### Delivery contract

The worker POSTs the payload to the subscribed URL with these headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-GTD-Event` | The event name (e.g. `item.created`). |
| `X-GTD-Delivery-Id` | UUID of the delivery — useful for idempotent receivers. |
| `X-GTD-Signature` | `sha256=<hex>`, where hex is `HMAC-SHA256(secret, body)`. |

**Verifying signatures (Node.js example):**

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isValidSignature(secret, body, signatureHeader) {
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    return a.length === b.length && timingSafeEqual(a, b);
}
```

### Retry & disable policy

- 3 attempts per delivery, with exponential backoff: 1m → 5m → 30m.
- After 3 failed attempts the delivery is abandoned (audit log retained).
- After **7 consecutive abandoned deliveries**, the subscription is auto-disabled. New events are not enqueued for disabled subscriptions; the row stays visible in `GET /v1/webhooks` with `disabledTs` and `disabledReason: "consecutive_failures"` set so the user can see what happened. Delete and re-create to reactivate.

### Production gating

The delivery worker is **off by default in production**. Set `WEBHOOKS_ENABLED=true` on the Cloud Run service to turn it on. In dev/test the worker runs by default.

---

## How the public API relates to `/sync`

Every public-API write is converted into the same `OperationInterface` snapshot the in-app sync layer uses, then handed to the same `applyEntitySnapshotOp` helper (`api-server/src/routes/sync.ts`). Consequences:

- Live clients receive an SSE `update` event immediately.
- Closed clients with web push enabled receive a notification.
- The operation is in the operations log, so every other device pulls it on the next `/sync/pull`.
- Calendar pushback fires for completes on calendar-linked items.

There is no second write path, no risk of the sync log diverging from REST writes, and no special-case purge logic. Public-API ops are subject to the same purge floor as device ops.

## Multi-account workflows

A user with two GTD accounts (e.g. personal + work) can drive cross-account moves via two tokens carried in one request. The caller's `reassign` token does the move; the recipient's `reassign.accept` token authorises the receive. Both must be live and distinct.

**Direct curl**

```bash
# 1. Mint each side's token in its own Settings → Personal API tokens UI:
#      Personal account: scope = reassign       → A_TOKEN
#      Work account:     scope = reassign.accept → B_TOKEN
# 2. Look up the work account's userId (you don't need to copy a UUID — the MCP path below
#    resolves it automatically; this curl shows the underlying request shape).
B_USER_ID=$(curl -sH "Authorization: Bearer $B_TOKEN" https://api.getting-things-done.app/v1/me | jq -r .userId)
# 3. Move the item.
curl -X POST https://api.getting-things-done.app/v1/reassign \
    -H "Authorization: Bearer $A_TOKEN" \
    -H "X-Reassign-Recipient-Token: $B_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"entityType\":\"item\",\"entityId\":\"...\",\"toUserId\":\"$B_USER_ID\"}"
```

**Local MCP equivalent** (the recommended path — no raw UUIDs in your shell history):

```jsonc
// Claude Desktop / Claude Code config
{
  "mcpServers": {
    "gtd": {
      "command": "node",
      "args": ["/path/to/gtd/mcp-server/dist/index.js"],
      "env": {
        "GTD_API_BASE": "http://localhost:4000",
        "GTD_API_TOKEN": "gtd_…",        // personal (default account, scope: reassign)
        "GTD_API_TOKEN_WORK": "gtd_…"    // work    (account label "work", scope: reassign.accept)
      }
    }
  }
}
```

The model then calls `gtd_reassign` with `fromAccount: "default", toAccount: "work", entityType: "item", entityId: "…"`. The MCP looks up the work account's userId via `GET /v1/me` on the recipient token, attaches both bearers, and posts to `/v1/reassign`.

## Local MCP server

A stdio MCP server lives at [`mcp-server/`](../mcp-server/) and exposes the full `/v1` surface as tools (capture, list, get, update, complete for items; full CRUD for routines/people/workContexts; pause/resume/split composites; reassign; batch). Every tool accepts an optional `account` arg that selects which configured token signs the call; `gtd_reassign` accepts `fromAccount` / `toAccount` to assemble the two-token consent gesture. The token's scopes are enforced server-side, so the MCP layer is a thin shim.

See [`mcp-server/README.md`](../mcp-server/README.md) for the build and Claude Desktop / Claude Code config snippet.

### Why no item delete tool

There is no `DELETE /v1/items/:id`, and `PATCH` rejects `{status: 'trash'}` — there is no `/v1` restore endpoint, so trashing through the public surface would create unrecoverable rows. The MCP server reflects this: trashing an item requires an explicit `gtd_batch` op (`{entityType:'item', opType:'delete', ...}`). Keeping destructive item ops behind the explicit batch tool is intentional safety for an LLM-driven surface.


## Implementation notes (for the API server)

These are not part of the public contract, but help reviewers map the docs onto code:

- New router: `api-server/src/routes/v1Items.ts`, mounted in `index.ts` at `.route('/v1', v1Router)` where `v1Router` aggregates item routes (and any future v1 routes).
- New DAO: `apiTokensDAO` for the `apiTokens` collection. Schema: `{ _id, user, tokenHash (sha256 hex), label, createdTs, lastUsedTs, revokedTs? }`. Unique index on `tokenHash`.
- New middleware: `authenticateBearer` parses `Authorization: Bearer gtd_<…>`, hashes, looks up by `tokenHash`, rejects if `revokedTs` set. On success it sets `c.set('session', { user: { id: token.user } })` so handlers can be agnostic about the auth source.
- Content-hash dedupe: `sha256(title + '
- `externalId`: stored as a top-level field on `ItemInterface`. Sparse unique index on `(user, externalId)`. Add to the type with a JSDoc comment noting it is set only via the public API.
- Each public-API mutation builds an `OperationInterface` (`deviceId = "api:<tokenId>"`, server-generated `ts`, full snapshot) and calls `applyEntitySnapshotOp` plus `notifyUserViaSse` / `notifyViaWebPush` / `maybePushToGCal` exactly as `/sync/push` does. The handler does not duplicate that logic — it imports the helpers.
