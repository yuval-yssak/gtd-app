import { createHash, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import type { Filter } from 'mongodb';
import { authenticateBearer, type BearerVariables } from '../auth/bearerMiddleware.js';
import { anonymousRateLimit, authenticatedRateLimit } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { buildCalendarProvider } from '../lib/buildCalendarProvider.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import { recordOperation } from '../lib/operationHelpers.js';
import { notifyUserViaSse } from '../lib/sseConnections.js';
import { notifyViaWebPush } from '../lib/webPush.js';
import { type ItemInterface, ItemStatus, type OperationInterface } from '../types/entities.js';

// 24h content-dedupe window: covers retries / double-taps without collapsing genuine recurring
// captures. Callers wanting strict idempotency should provide externalId instead.
const CONTENT_DEDUPE_WINDOW_HOURS = 24;
// `done` is the only public-API transition. `trash` is intentionally not allowed: undeleting
// requires the in-app UI and silently trashing items via the API would surprise users.
const COMPLETABLE_FROM: ReadonlyArray<ItemInterface['status']> = ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done'];

const ITEM_STATUSES = new Set<ItemInterface['status']>(Object.values(ItemStatus));

interface CreateItemBody {
    title?: unknown;
    notes?: unknown;
    externalId?: unknown;
}

interface ParsedCreateBody {
    title: string;
    notes?: string;
    externalId?: string;
}

type CreateBodyError = { code: 'invalid_title' | 'invalid_notes' | 'invalid_external_id'; message: string };

/** Parses & validates the `POST /items` body. Pure — no DB access. */
function parseCreateBody(raw: CreateItemBody): { ok: true; value: ParsedCreateBody } | { ok: false; error: CreateBodyError } {
    if (typeof raw.title !== 'string' || raw.title.trim() === '') {
        return { ok: false, error: { code: 'invalid_title', message: 'title must be a non-empty string' } };
    }
    if (raw.notes !== undefined && typeof raw.notes !== 'string') {
        return { ok: false, error: { code: 'invalid_notes', message: 'notes must be a string when provided' } };
    }
    if (raw.externalId !== undefined && (typeof raw.externalId !== 'string' || raw.externalId.trim() === '')) {
        return { ok: false, error: { code: 'invalid_external_id', message: 'externalId must be a non-empty string when provided' } };
    }
    const value: ParsedCreateBody = { title: raw.title.trim() };
    if (raw.notes !== undefined) value.notes = raw.notes;
    if (raw.externalId !== undefined) value.externalId = (raw.externalId as string).trim();
    return { ok: true, value };
}

/** sha256 hex of `${title}\n${notes ?? ''}` — the dedupe key for unkeyed inbox captures. */
function computeContentHash(title: string, notes: string | undefined): string {
    return createHash('sha256')
        .update(`${title}\n${notes ?? ''}`)
        .digest('hex');
}

/** Looks up an inbox item with this content hash created within the dedupe window. Null if none. */
async function findRecentDuplicate(userId: string, contentHash: string): Promise<ItemInterface | null> {
    const cutoff = dayjs().subtract(CONTENT_DEDUPE_WINDOW_HOURS, 'hour').toISOString();
    return itemsDAO.findOne({ user: userId, status: 'inbox', contentHash, createdTs: { $gte: cutoff } });
}

/** Looks up an existing item by user+externalId. Null if none. */
async function findByExternalId(userId: string, externalId: string): Promise<ItemInterface | null> {
    return itemsDAO.findOne({ user: userId, externalId });
}

/**
 * Fans out a server-originated change to live clients (SSE), closed clients (web push), and
 * Google Calendar (best-effort pushback). Shared by both the create and complete paths so the
 * notification logic stays in one place.
 */
async function notifyChange(op: OperationInterface, tokenId: string): Promise<void> {
    notifyUserViaSse(op.user, { type: 'update', ts: op.ts });
    // excludeDeviceId is null because the public API has no real client device — every device for
    // this user is a candidate for the push notification.
    await notifyViaWebPush(op.user, null, [op], op.ts);
    void maybePushToGCal(op, buildCalendarProvider).catch((err) => {
        console.error('[v1-items] gcal pushback failed', { tokenId, opType: op.opType, err });
    });
}

/** Mongo duplicate-key error code. Surfaces from inserts that violate the (user, externalId) unique index. */
function isDuplicateKeyError(err: unknown): boolean {
    return err instanceof Error && 'code' in err && (err as { code: number }).code === 11000;
}

/**
 * Persists a new inbox item: writes the entity, records a server-originated `create` op, and
 * fans out the change. Returns the persisted item. The caller is responsible for handling
 * E11000 duplicate-key errors raised by the (user, externalId) sparse-unique index — see
 * `resolveCreateItem` for the race-loser recovery path.
 */
async function persistNewInboxItem(item: ItemInterface, tokenId: string): Promise<ItemInterface> {
    await itemsDAO.insertOne(item);
    const op = await recordOperation(item.user, {
        entityType: 'item',
        entityId: item._id ?? '',
        snapshot: item,
        opType: 'create',
        now: item.updatedTs,
        deviceId: `api:${tokenId}`,
    });
    await notifyChange(op, tokenId);
    return item;
}

interface CreateItemContext {
    userId: string;
    tokenId: string;
    body: ParsedCreateBody;
}

/**
 * Resolves `POST /items` against the dedupe rules. Returns the item plus whether it was a replay.
 *
 * Race semantics:
 *   - `externalId` is enforced by a sparse-unique index. If two simultaneous calls slip past the
 *     pre-insert SELECT, the loser's INSERT raises E11000; we re-fetch by externalId and treat
 *     the whole thing as a replay. This makes `externalId` strictly idempotent under concurrency.
 *   - Content-hash dedupe (no externalId) is best-effort: there is no unique index, because a
 *     unique index on (user, status, contentHash) would block genuinely recurring captures
 *     (e.g. "Take medication" each day). Two concurrent identical posts within the dedupe
 *     window can therefore produce two rows. Callers wanting strict idempotency must supply
 *     `externalId` — this is documented in PUBLIC_API.md.
 */
async function resolveCreateItem({ userId, tokenId, body }: CreateItemContext): Promise<{ item: ItemInterface; replayed: boolean }> {
    if (body.externalId) {
        const existing = await findByExternalId(userId, body.externalId);
        if (existing) {
            return { item: existing, replayed: true };
        }
    }
    const contentHash = computeContentHash(body.title, body.notes);
    if (!body.externalId) {
        const duplicate = await findRecentDuplicate(userId, contentHash);
        if (duplicate) {
            return { item: duplicate, replayed: true };
        }
    }
    const now = dayjs().toISOString();
    const item: ItemInterface = {
        _id: randomUUID(),
        user: userId,
        status: 'inbox',
        title: body.title,
        createdTs: now,
        updatedTs: now,
        contentHash,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.externalId ? { externalId: body.externalId } : {}),
    };
    try {
        const persisted = await persistNewInboxItem(item, tokenId);
        return { item: persisted, replayed: false };
    } catch (err) {
        // The only unique constraint that can fire here is (user, externalId) — see itemsDAO.ts.
        // The race-winner already inserted; resolve the user's request against that row instead
        // of bubbling a 500. Without externalId, the unique index doesn't apply, so this branch
        // can only be reached when externalId is set — but we guard defensively anyway.
        if (isDuplicateKeyError(err) && body.externalId) {
            const winner = await findByExternalId(userId, body.externalId);
            if (winner) {
                return { item: winner, replayed: true };
            }
        }
        throw err;
    }
}

interface ListQuery {
    q?: string;
    statuses?: ItemInterface['status'][];
    since?: string;
    limit: number;
    cursor?: { updatedTs: string; id: string };
}

type ListQueryError = { code: 'invalid_status' | 'invalid_limit' | 'invalid_cursor'; message: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Parses & validates list query params. Pure. */
function parseListQuery(url: URL): { ok: true; value: ListQuery } | { ok: false; error: ListQueryError } {
    const q = url.searchParams.get('q') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const statuses = statusParam ? statusParam.split(',').map((s) => s.trim()) : undefined;
    if (statuses) {
        const invalid = statuses.find((s) => !ITEM_STATUSES.has(s as ItemInterface['status']));
        if (invalid !== undefined) {
            return { ok: false, error: { code: 'invalid_status', message: `unknown status "${invalid}"` } };
        }
    }
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : DEFAULT_LIMIT;
    if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
        return { ok: false, error: { code: 'invalid_limit', message: `limit must be between 1 and ${MAX_LIMIT}` } };
    }
    const cursor = parseCursor(url.searchParams.get('cursor'));
    if (cursor === 'invalid') {
        return { ok: false, error: { code: 'invalid_cursor', message: 'cursor is malformed' } };
    }
    const value: ListQuery = { limit };
    if (q !== undefined) value.q = q;
    if (statuses) value.statuses = statuses as ItemInterface['status'][];
    const since = url.searchParams.get('since');
    if (since) value.since = since;
    if (cursor) value.cursor = cursor;
    return { ok: true, value };
}

/** Encodes the last item's (updatedTs, _id) as an opaque base64url cursor. */
function encodeCursor(item: ItemInterface): string {
    return Buffer.from(JSON.stringify({ u: item.updatedTs, i: item._id })).toString('base64url');
}

/** Decodes a cursor or returns 'invalid' on malformed input. null when absent. */
function parseCursor(raw: string | null): { updatedTs: string; id: string } | null | 'invalid' {
    if (!raw) {
        return null;
    }
    try {
        const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { u?: unknown; i?: unknown };
        if (typeof decoded.u !== 'string' || typeof decoded.i !== 'string') {
            return 'invalid';
        }
        return { updatedTs: decoded.u, id: decoded.i };
    } catch {
        return 'invalid';
    }
}

/**
 * Builds the Mongo filter for `GET /items`. Status defaults to "everything except trash" so
 * scripts asking for the user's stuff don't have to filter trash explicitly.
 */
function buildListFilter(userId: string, query: ListQuery): Filter<ItemInterface> {
    const filter: Filter<ItemInterface> = {
        user: userId,
        status: query.statuses ? { $in: query.statuses } : { $ne: 'trash' },
    };
    if (query.since) {
        filter.updatedTs = { $gt: query.since };
    }
    if (query.q) {
        // Case-insensitive substring match on title and notes. Acceptable for the GTD scale.
        // A full-text index would be the next step if user libraries get large.
        const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = { $regex: escaped, $options: 'i' };
        filter.$or = [{ title: regex }, { notes: regex }];
    }
    if (query.cursor) {
        // Strictly-less-than (updatedTs, _id) using compound predicate. updatedTs DESC primary key,
        // _id DESC tiebreak so two items written in the same millisecond paginate deterministically.
        filter.$and = [
            {
                $or: [{ updatedTs: { $lt: query.cursor.updatedTs } }, { updatedTs: query.cursor.updatedTs, _id: { $lt: query.cursor.id } }],
            },
        ];
    }
    return filter;
}

interface CompleteContext {
    userId: string;
    tokenId: string;
    itemId: string;
}

type CompleteResult =
    | { ok: true; item: ItemInterface; alreadyDone: boolean }
    | { ok: false; status: 404 | 409; code: 'not_found' | 'not_completable'; message: string };

/** Marks an item done if allowed; idempotent for already-done items. Pure of fan-out — caller decides. */
async function completeItem({ userId, tokenId, itemId }: CompleteContext): Promise<CompleteResult> {
    const existing = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!existing) {
        return { ok: false, status: 404, code: 'not_found', message: 'item not found' };
    }
    if (existing.status === 'done') {
        return { ok: true, item: existing, alreadyDone: true };
    }
    if (!COMPLETABLE_FROM.includes(existing.status)) {
        return { ok: false, status: 409, code: 'not_completable', message: `cannot complete item in status "${existing.status}"` };
    }
    const now = dayjs().toISOString();
    const updated: ItemInterface = { ...existing, status: 'done', updatedTs: now };
    await itemsDAO.replaceById(itemId, updated);
    const op = await recordOperation(userId, {
        entityType: 'item',
        entityId: itemId,
        snapshot: updated,
        opType: 'update',
        now,
        deviceId: `api:${tokenId}`,
    });
    await notifyChange(op, tokenId);
    return { ok: true, item: updated, alreadyDone: false };
}

/**
 * Allowlist projection for API responses. We use an allowlist (not an omit) so that a future
 * internal sync-anchor field added to ItemInterface (e.g. another lastSyncedXxxTs) does not
 * silently leak into the public schema and become a de-facto API contract. The fields below
 * mirror the documented v1 schema in PUBLIC_API.md.
 */
type PublicItem = Pick<
    ItemInterface,
    | '_id'
    | 'user'
    | 'status'
    | 'title'
    | 'notes'
    | 'createdTs'
    | 'updatedTs'
    | 'externalId'
    | 'workContextIds'
    | 'peopleIds'
    | 'waitingForPersonId'
    | 'expectedBy'
    | 'ignoreBefore'
    | 'timeStart'
    | 'timeEnd'
    | 'energy'
    | 'time'
    | 'focus'
    | 'urgent'
    | 'routineId'
    | 'calendarEventId'
    | 'calendarIntegrationId'
    | 'calendarSyncConfigId'
>;

const PUBLIC_FIELDS: ReadonlyArray<keyof PublicItem> = [
    '_id',
    'user',
    'status',
    'title',
    'notes',
    'createdTs',
    'updatedTs',
    'externalId',
    'workContextIds',
    'peopleIds',
    'waitingForPersonId',
    'expectedBy',
    'ignoreBefore',
    'timeStart',
    'timeEnd',
    'energy',
    'time',
    'focus',
    'urgent',
    'routineId',
    'calendarEventId',
    'calendarIntegrationId',
    'calendarSyncConfigId',
];

function presentItem(item: ItemInterface): PublicItem {
    const out: Partial<PublicItem> = {};
    for (const key of PUBLIC_FIELDS) {
        const value = item[key];
        if (value !== undefined) {
            // Per-key copy through `as never` is the only way to satisfy a heterogeneous Pick
            // assignment loop without per-field branching — value's type is already narrowed
            // by the source ItemInterface key.
            (out as Record<string, unknown>)[key] = value;
        }
    }
    return out as PublicItem;
}

export const v1ItemsRoutes = new Hono<{ Variables: BearerVariables }>()
    // Anonymous limiter runs first so a flood of bad-credential calls can't burn through
    // tokenHash lookups on the apiTokens collection.
    .use('*', anonymousRateLimit())
    .use('*', authenticateBearer)
    // Per-token limiter runs AFTER auth so it has tokenId to scope by. Read and write
    // buckets are independent (see `rateLimitMiddleware.ts`).
    .use('*', authenticatedRateLimit())

    // ── POST /v1/items — capture an inbox item ──────────────────────────────
    .post('/items', async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const raw = (await c.req.json().catch(() => null)) as CreateItemBody | null;
        if (!raw || typeof raw !== 'object') {
            return c.json({ error: 'request body must be a JSON object', code: 'invalid_body' }, 400);
        }
        const parsed = parseCreateBody(raw);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
        }
        const { item, replayed } = await resolveCreateItem({ userId, tokenId, body: parsed.value });
        if (replayed) {
            c.header('X-Idempotent-Replay', 'true');
        }
        return c.json(presentItem(item), 201);
    })

    // ── GET /v1/items — list / search ───────────────────────────────────────
    .get('/items', async (c) => {
        const { userId } = c.var.apiAuth;
        const parsed = parseListQuery(new URL(c.req.url));
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
        }
        const query = parsed.value;
        const filter = buildListFilter(userId, query);
        // Fetch limit+1 so we can tell whether another page exists without a separate count query.
        const rows = await itemsDAO.findArray(filter, { sort: { updatedTs: -1, _id: -1 }, limit: query.limit + 1 });
        const hasMore = rows.length > query.limit;
        const page = hasMore ? rows.slice(0, query.limit) : rows;
        const last = page.at(-1);
        const nextCursor = hasMore && last ? encodeCursor(last) : undefined;
        return c.json({ items: page.map(presentItem), ...(nextCursor ? { nextCursor } : {}) });
    })

    // ── GET /v1/items/:id ───────────────────────────────────────────────────
    .get('/items/:id', async (c) => {
        const { userId } = c.var.apiAuth;
        const id = c.req.param('id');
        const item = await itemsDAO.findByOwnerAndId(id, userId);
        if (!item) {
            return c.json({ error: 'item not found', code: 'not_found' }, 404);
        }
        return c.json(presentItem(item));
    })

    // ── POST /v1/items/:id/complete ─────────────────────────────────────────
    .post('/items/:id/complete', async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const result = await completeItem({ userId, tokenId, itemId: id });
        if (!result.ok) {
            return c.json({ error: result.message, code: result.code }, result.status);
        }
        if (result.alreadyDone) {
            c.header('X-Idempotent-Replay', 'true');
        }
        return c.json(presentItem(result.item));
    });
