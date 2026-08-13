import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import workContextsDAO from '../../dataAccess/workContextsDAO.js';
import { applyAndPublishOperation, OperationValidationError } from '../../lib/applyOperation.js';
import type { WorkContextInterface } from '../../types/entities.js';
import { presentWorkContext } from './projections/workContext.js';

/**
 * Public-API CRUD for the user's work-context catalogue. Read endpoints (`items.read` carry-over
 * preserved for back-compat plus the new `contexts.read`) feed the clarify-inbox-item flow; write
 * endpoints (`contexts.write`) let integrations manage the catalogue programmatically.
 *
 * Every write goes through `applyAndPublishOperation` in strict mode so the same validation,
 * operations log, SSE/web-push fan-out, and webhook delivery that `/sync/push` enjoys also covers
 * the public surface — no contract drift.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface ListQuery {
    limit: number;
    cursor?: { updatedTs: string; id: string };
    since?: string;
}

type ListQueryError = { code: 'invalid_limit' | 'invalid_cursor'; message: string };

function parseListQuery(url: URL): { ok: true; value: ListQuery } | { ok: false; error: ListQueryError } {
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
    if (cursor) value.cursor = cursor;
    const since = url.searchParams.get('since');
    if (since) value.since = since;
    return { ok: true, value };
}

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

function encodeCursor(row: { updatedTs: string; _id: string }): string {
    return Buffer.from(JSON.stringify({ u: row.updatedTs, i: row._id })).toString('base64url');
}

interface CursorFilter {
    user: string;
    updatedTs?: { $gt: string };
    $or?: Array<{ updatedTs: unknown; _id?: { $lt: string } }>;
}

function buildFilter(userId: string, query: ListQuery): CursorFilter {
    const filter: CursorFilter = { user: userId };
    if (query.since) {
        filter.updatedTs = { $gt: query.since };
    }
    if (query.cursor) {
        // Same compound (updatedTs DESC, _id DESC) cursor as routes/v1/items.
        filter.$or = [{ updatedTs: { $lt: query.cursor.updatedTs } }, { updatedTs: query.cursor.updatedTs, _id: { $lt: query.cursor.id } }];
    }
    return filter;
}

// Same allowlist for POST and PATCH — `_id`, `user`, `createdTs`, `updatedTs` are server-managed
// and rejected with `forbidden_field` rather than silently dropped.
const ALLOWED_FIELDS = new Set(['name', 'archived']);

interface CreateBody {
    name?: unknown;
    archived?: unknown;
    [key: string]: unknown;
}

type ParseError = { status: 400; code: 'invalid_body' | 'empty_body' | 'invalid_name' | 'invalid_archived' | 'forbidden_field'; message: string };

interface ParsedContextFields {
    name?: string;
    archived?: boolean;
}

function assertAllowedKeys(raw: object): { ok: true } | { ok: false; offending: string } {
    for (const key of Object.keys(raw)) {
        if (!ALLOWED_FIELDS.has(key)) {
            return { ok: false, offending: key };
        }
    }
    return { ok: true };
}

/** Validates the optional fields shared by POST and PATCH. Pure. */
function parseContextFields(raw: CreateBody): { ok: true; value: ParsedContextFields } | { ok: false; error: ParseError } {
    const value: ParsedContextFields = {};
    if (raw.name !== undefined) {
        if (typeof raw.name !== 'string' || raw.name.trim() === '') {
            return { ok: false, error: { status: 400, code: 'invalid_name', message: 'name must be a non-empty string' } };
        }
        value.name = raw.name.trim();
    }
    if (raw.archived !== undefined) {
        if (typeof raw.archived !== 'boolean') {
            return { ok: false, error: { status: 400, code: 'invalid_archived', message: 'archived must be a boolean' } };
        }
        value.archived = raw.archived;
    }
    return { ok: true, value };
}

/** Validates the create body. Pure. */
function parseCreateBody(raw: CreateBody | null): { ok: true; value: ParsedContextFields & { name: string } } | { ok: false; error: ParseError } {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { status: 400, code: 'invalid_body', message: 'request body must be a JSON object' } };
    }
    const allowed = assertAllowedKeys(raw);
    if (!allowed.ok) {
        return { ok: false, error: { status: 400, code: 'forbidden_field', message: `field "${allowed.offending}" cannot be set via the public API` } };
    }
    if (raw.name === undefined) {
        return { ok: false, error: { status: 400, code: 'invalid_name', message: 'name must be a non-empty string' } };
    }
    const parsed = parseContextFields(raw);
    if (!parsed.ok) {
        return parsed;
    }
    // parseContextFields validated raw.name (present per the precondition above) as non-empty.
    if (parsed.value.name === undefined) {
        throw new Error('parseContextFields invariant: name should be set after the precondition check');
    }
    return { ok: true, value: { ...parsed.value, name: parsed.value.name } };
}

function parsePatchBody(raw: CreateBody | null): { ok: true; value: ParsedContextFields } | { ok: false; error: ParseError } {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { status: 400, code: 'invalid_body', message: 'request body must be a JSON object' } };
    }
    const allowed = assertAllowedKeys(raw);
    if (!allowed.ok) {
        return { ok: false, error: { status: 400, code: 'forbidden_field', message: `field "${allowed.offending}" cannot be set via the public API` } };
    }
    if (Object.keys(raw).length === 0) {
        return { ok: false, error: { status: 400, code: 'empty_body', message: 'PATCH body must include at least one field' } };
    }
    return parseContextFields(raw);
}

export const v1WorkContextsRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // ── POST /v1/work-contexts ──────────────────────────────────────────────
    .post('/work-contexts', requireScope('contexts.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const raw = (await c.req.json().catch(() => null)) as CreateBody | null;
        const parsed = parseCreateBody(raw);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, parsed.error.status);
        }
        const now = dayjs().toISOString();
        const snapshot: WorkContextInterface = {
            _id: randomUUID(),
            user: userId,
            name: parsed.value.name,
            ...(parsed.value.archived !== undefined ? { archived: parsed.value.archived } : {}),
            createdTs: now,
            updatedTs: now,
        };
        await applyAndPublishOperation(
            userId,
            { entityType: 'workContext', opType: 'create', entityId: snapshot._id, snapshot },
            { deviceId: `api:${tokenId}`, now, strict: true },
        );
        return c.json(presentWorkContext(snapshot), 201);
    })

    // ── GET /v1/work-contexts ───────────────────────────────────────────────
    .get('/work-contexts', requireScope('contexts.read'), async (c) => {
        const { userId } = c.var.apiAuth;
        const parsed = parseListQuery(new URL(c.req.url));
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
        }
        const filter = buildFilter(userId, parsed.value);
        const rows = await workContextsDAO.findArray(filter as never, { sort: { updatedTs: -1, _id: -1 }, limit: parsed.value.limit + 1 });
        const hasMore = rows.length > parsed.value.limit;
        const page = hasMore ? rows.slice(0, parsed.value.limit) : rows;
        const last = page.at(-1);
        const nextCursor = hasMore && last ? encodeCursor(last) : undefined;
        return c.json({ workContexts: page.map(presentWorkContext), ...(nextCursor ? { nextCursor } : {}) });
    })

    // ── GET /v1/work-contexts/:id ───────────────────────────────────────────
    .get('/work-contexts/:id', requireScope('contexts.read'), async (c) => {
        const { userId } = c.var.apiAuth;
        const id = c.req.param('id');
        const wc = await workContextsDAO.findByOwnerAndId(id, userId);
        if (!wc) {
            return c.json({ error: 'work context not found', code: 'not_found' }, 404);
        }
        return c.json(presentWorkContext(wc));
    })

    // ── PATCH /v1/work-contexts/:id ─────────────────────────────────────────
    .patch('/work-contexts/:id', requireScope('contexts.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const raw = (await c.req.json().catch(() => null)) as CreateBody | null;
        const parsed = parsePatchBody(raw);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, parsed.error.status);
        }
        const existing = await workContextsDAO.findByOwnerAndId(id, userId);
        if (!existing) {
            return c.json({ error: 'work context not found', code: 'not_found' }, 404);
        }
        const now = dayjs().toISOString();
        const snapshot: WorkContextInterface = { ...existing, ...parsed.value, updatedTs: now };
        try {
            await applyAndPublishOperation(
                userId,
                { entityType: 'workContext', opType: 'update', entityId: id, snapshot },
                { deviceId: `api:${tokenId}`, now, strict: true },
            );
        } catch (err) {
            if (err instanceof OperationValidationError) {
                return c.json({ error: err.failure.message, code: err.failure.code, ...(err.failure.path ? { path: err.failure.path } : {}) }, 400);
            }
            throw err;
        }
        return c.json(presentWorkContext(snapshot));
    })

    // ── DELETE /v1/work-contexts/:id ────────────────────────────────────────
    // Idempotent: deleting an already-missing row returns 200 with `alreadyDeleted: true`. This
    // is a deliberate divergence from `DELETE /account/tokens/:id` (which returns 404) — for
    // public-API integrations a delete-after-delete is normally a benign retry, not an error.
    .delete('/work-contexts/:id', requireScope('contexts.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const existing = await workContextsDAO.findByOwnerAndId(id, userId);
        if (!existing) {
            return c.json({ ok: true, alreadyDeleted: true });
        }
        await applyAndPublishOperation(
            userId,
            { entityType: 'workContext', opType: 'delete', entityId: id, snapshot: null },
            { deviceId: `api:${tokenId}`, strict: true },
        );
        return c.json({ ok: true });
    });
