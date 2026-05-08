import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import peopleDAO from '../../dataAccess/peopleDAO.js';
import { applyAndPublishOperation, OperationValidationError } from '../../lib/applyOperation.js';
import type { PersonInterface } from '../../types/entities.js';
import { presentPerson } from './projections/person.js';

/**
 * Public-API CRUD for the user's people catalogue. Read endpoints (`people.read`) feed the
 * clarify-inbox-item flow so an LLM can populate `peopleIds`/`waitingForPersonId` from real
 * server-side ids; write endpoints (`people.write`) let integrations manage the catalogue.
 *
 * Every write goes through `applyAndPublishOperation` in strict mode so the same validation,
 * operations log, and SSE/web-push/webhook fan-out cover the public surface.
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

interface CreateBody {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    externalCalendarId?: unknown;
    notes?: unknown;
}

interface PatchBody {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    externalCalendarId?: unknown;
    notes?: unknown;
    /** Catch-all so we can detect forbidden_field. */
    [key: string]: unknown;
}

// Same allowlist for POST and PATCH. `_id`, `user`, `createdTs`, `updatedTs` are server-managed
// and rejected with `forbidden_field` rather than silently dropped.
const ALLOWED_FIELDS = new Set(['name', 'email', 'phone', 'externalCalendarId', 'notes']);

function assertAllowedKeys(raw: object): { ok: true } | { ok: false; offending: string } {
    for (const key of Object.keys(raw)) {
        if (!ALLOWED_FIELDS.has(key)) {
            return { ok: false, offending: key };
        }
    }
    return { ok: true };
}

interface ParsedPersonFields {
    name?: string;
    email?: string;
    phone?: string;
    externalCalendarId?: string;
    notes?: string;
}

type ParseError = { status: 400; code: string; message: string };

interface PersonFieldsBag {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    externalCalendarId?: unknown;
    notes?: unknown;
}

/** Parses optional string fields against a small schema. Pure. */
function parsePersonFields(raw: PersonFieldsBag): { ok: true; value: ParsedPersonFields } | { ok: false; error: ParseError } {
    const value: ParsedPersonFields = {};
    if (raw.name !== undefined) {
        if (typeof raw.name !== 'string' || raw.name.trim() === '') {
            return { ok: false, error: { status: 400, code: 'invalid_name', message: 'name must be a non-empty string' } };
        }
        value.name = raw.name.trim();
    }
    if (raw.email !== undefined) {
        if (typeof raw.email !== 'string') {
            return { ok: false, error: { status: 400, code: 'invalid_email', message: 'email must be a string' } };
        }
        value.email = raw.email;
    }
    if (raw.phone !== undefined) {
        if (typeof raw.phone !== 'string') {
            return { ok: false, error: { status: 400, code: 'invalid_phone', message: 'phone must be a string' } };
        }
        value.phone = raw.phone;
    }
    if (raw.externalCalendarId !== undefined) {
        if (typeof raw.externalCalendarId !== 'string' || raw.externalCalendarId.trim() === '') {
            return {
                ok: false,
                error: { status: 400, code: 'invalid_externalCalendarId', message: 'externalCalendarId must be a non-empty string when provided' },
            };
        }
        value.externalCalendarId = raw.externalCalendarId.trim();
    }
    if (raw.notes !== undefined) {
        if (typeof raw.notes !== 'string') {
            return { ok: false, error: { status: 400, code: 'invalid_notes', message: 'notes must be a string' } };
        }
        value.notes = raw.notes;
    }
    return { ok: true, value };
}

function parseCreateBody(raw: CreateBody | null): { ok: true; value: ParsedPersonFields & { name: string } } | { ok: false; error: ParseError } {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { status: 400, code: 'invalid_body', message: 'request body must be a JSON object' } };
    }
    const allowed = assertAllowedKeys(raw);
    if (!allowed.ok) {
        return { ok: false, error: { status: 400, code: 'forbidden_field', message: `field "${allowed.offending}" cannot be set via the public API` } };
    }
    if (raw.name === undefined) {
        return { ok: false, error: { status: 400, code: 'invalid_name', message: 'name is required' } };
    }
    const parsed = parsePersonFields(raw);
    if (!parsed.ok) {
        return parsed;
    }
    // parsePersonFields trims+validates raw.name as non-empty when present; the precondition
    // above confirmed it WAS present, so `name` is always set here. Throw rather than fall back
    // to an empty string — silently coercing here would only mask a future invariant violation.
    if (parsed.value.name === undefined) {
        throw new Error('parsePersonFields invariant: name should be set after the precondition check');
    }
    return { ok: true, value: { ...parsed.value, name: parsed.value.name } };
}

function parsePatchBody(raw: PatchBody | null): { ok: true; value: ParsedPersonFields } | { ok: false; error: ParseError } {
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
    return parsePersonFields(raw);
}

export const v1PeopleRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // ── POST /v1/people ─────────────────────────────────────────────────────
    .post('/people', requireScope('people.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const raw = (await c.req.json().catch(() => null)) as CreateBody | null;
        const parsed = parseCreateBody(raw);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, parsed.error.status);
        }
        const now = dayjs().toISOString();
        const snapshot: PersonInterface = {
            _id: randomUUID(),
            user: userId,
            name: parsed.value.name,
            createdTs: now,
            updatedTs: now,
            ...(parsed.value.email !== undefined ? { email: parsed.value.email } : {}),
            ...(parsed.value.phone !== undefined ? { phone: parsed.value.phone } : {}),
            ...(parsed.value.externalCalendarId !== undefined ? { externalCalendarId: parsed.value.externalCalendarId } : {}),
            ...(parsed.value.notes !== undefined ? { notes: parsed.value.notes } : {}),
        };
        await applyAndPublishOperation(
            userId,
            { entityType: 'person', opType: 'create', entityId: snapshot._id, snapshot },
            { deviceId: `api:${tokenId}`, now, strict: true },
        );
        return c.json(presentPerson(snapshot), 201);
    })

    // ── GET /v1/people ──────────────────────────────────────────────────────
    .get('/people', requireScope('people.read'), async (c) => {
        const { userId } = c.var.apiAuth;
        const parsed = parseListQuery(new URL(c.req.url));
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
        }
        const filter = buildFilter(userId, parsed.value);
        const rows = await peopleDAO.findArray(filter as never, { sort: { updatedTs: -1, _id: -1 }, limit: parsed.value.limit + 1 });
        const hasMore = rows.length > parsed.value.limit;
        const page = hasMore ? rows.slice(0, parsed.value.limit) : rows;
        const last = page.at(-1);
        const nextCursor = hasMore && last ? encodeCursor(last) : undefined;
        return c.json({ people: page.map(presentPerson), ...(nextCursor ? { nextCursor } : {}) });
    })

    // ── GET /v1/people/:id ──────────────────────────────────────────────────
    .get('/people/:id', requireScope('people.read'), async (c) => {
        const { userId } = c.var.apiAuth;
        const id = c.req.param('id');
        const person = await peopleDAO.findByOwnerAndId(id, userId);
        if (!person) {
            return c.json({ error: 'person not found', code: 'not_found' }, 404);
        }
        return c.json(presentPerson(person));
    })

    // ── PATCH /v1/people/:id ────────────────────────────────────────────────
    .patch('/people/:id', requireScope('people.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const raw = (await c.req.json().catch(() => null)) as PatchBody | null;
        const parsed = parsePatchBody(raw);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, parsed.error.status);
        }
        const existing = await peopleDAO.findByOwnerAndId(id, userId);
        if (!existing) {
            return c.json({ error: 'person not found', code: 'not_found' }, 404);
        }
        const now = dayjs().toISOString();
        const snapshot: PersonInterface = { ...existing, ...parsed.value, updatedTs: now };
        try {
            await applyAndPublishOperation(
                userId,
                { entityType: 'person', opType: 'update', entityId: id, snapshot },
                { deviceId: `api:${tokenId}`, now, strict: true },
            );
        } catch (err) {
            if (err instanceof OperationValidationError) {
                return c.json({ error: err.failure.message, code: err.failure.code, ...(err.failure.path ? { path: err.failure.path } : {}) }, 400);
            }
            throw err;
        }
        return c.json(presentPerson(snapshot));
    })

    // ── DELETE /v1/people/:id ───────────────────────────────────────────────
    // Idempotent: deleting a missing row returns 200 with `alreadyDeleted: true` (a delete-after-
    // delete is normally a benign retry, not an error). Deleting a person referenced from items
    // (peopleIds, waitingForPersonId) leaves the references dangling — the client treats
    // dangling references as "missing person" and renders accordingly. Cascading deletion is
    // intentionally NOT performed so callers can recover by re-creating the person with the
    // same _id within the same transaction window.
    .delete('/people/:id', requireScope('people.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const existing = await peopleDAO.findByOwnerAndId(id, userId);
        if (!existing) {
            return c.json({ ok: true, alreadyDeleted: true });
        }
        await applyAndPublishOperation(
            userId,
            { entityType: 'person', opType: 'delete', entityId: id, snapshot: null },
            { deviceId: `api:${tokenId}`, strict: true },
        );
        return c.json({ ok: true });
    });
