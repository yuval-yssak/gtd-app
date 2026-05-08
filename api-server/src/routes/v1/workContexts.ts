import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import workContextsDAO from '../../dataAccess/workContextsDAO.js';
import { presentWorkContext } from './projections/workContext.js';

/**
 * Read-only public-API surface for the user's work-context catalogue. Required by the
 * `clarify_inbox_item` MCP tool path so the model can populate `workContextIds` from real ids
 * rather than guessing strings. Mounted at `/v1/work-contexts` from `routes/v1/index.ts`.
 *
 * Response shape mirrors the items list shape: `{ items: [...] }`-style envelope, allowlist
 * projection (no `user` field), pagination via opaque cursor + `limit`. Reuses `items.read` scope.
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

export const v1WorkContextsRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // ── GET /v1/work-contexts ───────────────────────────────────────────────
    .get('/work-contexts', requireScope('items.read'), async (c) => {
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
    });
