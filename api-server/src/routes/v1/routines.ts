import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { Hono } from 'hono';

// Strict-format parsing for the splitDate validator below (a regex would accept "2099-13-45").
dayjs.extend(customParseFormat);

import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import routinesDAO from '../../dataAccess/routinesDAO.js';
import { applyAndPublishOperation, OperationValidationError } from '../../lib/applyOperation.js';
import { pauseRoutine, resumeRoutine, type SplitParams, splitRoutine } from '../../lib/routineComposites.js';
import { ensureFirstRoutineItem } from '../../lib/routineItemGeneration.js';
import type { RoutineInterface } from '../../types/entities.js';
import { presentRoutine } from './projections/routine.js';

/**
 * Public-API CRUD for the user's routines (recurring task templates). Reads (`routines.read`)
 * surface the catalogue; writes (`routines.write`) let integrations create / edit / delete.
 *
 * Routines have a richer shape than items / people / workContexts (RRULE, template, exception
 * list, calendar-link metadata), so the handlers here lean on `RoutineSnapshotSchema` (via the
 * shared apply pipeline's `strict: true` mode) for field-level validation rather than
 * re-implementing the schema in handcrafted parsers. Anything that fails Zod surfaces as a
 * 400 with a structured `{error, code, path?}`.
 *
 * Composite endpoints (`/pause`, `/resume`, `/split`) live in a sibling file and reuse this
 * router's CRUD primitives indirectly via the apply pipeline.
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
        filter.$or = [{ updatedTs: { $lt: query.cursor.updatedTs } }, { updatedTs: query.cursor.updatedTs, _id: { $lt: query.cursor.id } }];
    }
    return filter;
}

// Fields the caller may set on POST and PATCH. The snapshot derived from these is fully
// validated by `RoutineSnapshotSchema` downstream — this allowlist exists to reject server-
// managed state (sync anchors, exception list, split-history backref) and deprecated fields
// before they reach Zod, where the structural schema would otherwise accept them.
//
// Deliberately NOT in this list:
//   - `splitFromRoutineId` — set exclusively by the calendar split flow
//     (`routes/calendar.ts:1297`). Public PATCHes would corrupt split-history relationships
//     that the GCal split flow and `scripts/backfillSplitFromRoutineId.ts` depend on.
//   - `lastGeneratedDate` — server-side anchor for the next-occurrence generator. A caller
//     setting this can skip occurrences entirely or trigger re-generation.
//   - `routineExceptions` — server-maintained from GCal pushback (`lib/calendarPushback.ts`,
//     `routes/calendar.ts`). Public PATCHes would clobber recurrence skip/modify state.
//   - `lastPushedToGCalTs`, `lastSyncedNotes` — internal sync anchors (excluded by being
//     omitted from `RoutineInterface` writability here; Zod still accepts them structurally).
//   - `triggerMode`, `afterCompletionDelayDays` — `@deprecated` per `RoutineInterface` —
//     refusing to advertise them via the public API keeps new tokens off the deprecated path.
const WRITABLE_FIELDS = new Set<keyof RoutineInterface>([
    'title',
    'routineType',
    'rrule',
    'calendarEventId',
    'calendarIntegrationId',
    'calendarSyncConfigId',
    'template',
    'active',
    'startDate',
    'calendarItemTemplate',
]);

/**
 * Rejects request bodies that contain non-writable keys (`_id`, `user`, `createdTs`, etc.). Pure.
 * Returns the body as-is on success. Down-stream Zod validation handles type-level rejection.
 */
function checkWritableKeys(raw: Record<string, unknown>): { ok: true } | { ok: false; offending: string } {
    for (const key of Object.keys(raw)) {
        if (!WRITABLE_FIELDS.has(key as keyof RoutineInterface)) {
            return { ok: false, offending: key };
        }
    }
    return { ok: true };
}

interface ApplyError {
    status: 400 | 404;
    code: string;
    message: string;
    path?: ReadonlyArray<string | number>;
}

async function applyRoutineWrite(
    userId: string,
    tokenId: string,
    snapshot: RoutineInterface,
    opType: 'create' | 'update',
    now: string,
): Promise<{ ok: true } | { ok: false; error: ApplyError }> {
    try {
        await applyAndPublishOperation(
            userId,
            { entityType: 'routine', opType, entityId: snapshot._id, snapshot },
            { deviceId: `api:${tokenId}`, now, strict: true },
        );
        return { ok: true };
    } catch (err) {
        if (err instanceof OperationValidationError) {
            return {
                ok: false,
                error: {
                    status: 400,
                    code: err.failure.code,
                    message: err.failure.message,
                    ...(err.failure.path ? { path: err.failure.path } : {}),
                },
            };
        }
        throw err;
    }
}

export const v1RoutinesRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // ── POST /v1/routines ───────────────────────────────────────────────────
    .post('/routines', requireScope('routines.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!raw || typeof raw !== 'object') {
            return c.json({ error: 'request body must be a JSON object', code: 'invalid_body' }, 400);
        }
        const writable = checkWritableKeys(raw);
        if (!writable.ok) {
            return c.json({ error: `field "${writable.offending}" cannot be set via the public API`, code: 'forbidden_field' }, 400);
        }
        // Server-authoritative ids and timestamps; the rest comes from the body and gets validated by Zod.
        // Server fields land *last* so a future drift in `WRITABLE_FIELDS` cannot let caller-supplied
        // _id / user / createdTs / updatedTs override the authoritative values via spread.
        const now = dayjs().toISOString();
        const snapshot = { ...raw, _id: randomUUID(), user: userId, createdTs: now, updatedTs: now } as RoutineInterface;
        const result = await applyRoutineWrite(userId, tokenId, snapshot, 'create', now);
        if (!result.ok) {
            return c.json(
                { error: result.error.message, code: result.error.code, ...(result.error.path ? { path: result.error.path } : {}) },
                result.error.status,
            );
        }
        // Bootstrap the first nextAction item server-side so MCP/API-created routines don't depend
        // on a client tick to materialize their first occurrence. No-op for calendar routines and
        // inactive routines. Errors inside `ensureFirstRoutineItem` are logged + swallowed so a
        // bad rrule or item-generation hiccup never fails the parent create.
        await ensureFirstRoutineItem({ userId, tokenId }, snapshot);
        return c.json(presentRoutine(snapshot), 201);
    })

    // ── GET /v1/routines ────────────────────────────────────────────────────
    .get('/routines', requireScope('routines.read'), async (c) => {
        const { userId } = c.var.apiAuth;
        const parsed = parseListQuery(new URL(c.req.url));
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
        }
        const filter = buildFilter(userId, parsed.value);
        const rows = await routinesDAO.findArray(filter as never, { sort: { updatedTs: -1, _id: -1 }, limit: parsed.value.limit + 1 });
        const hasMore = rows.length > parsed.value.limit;
        const page = hasMore ? rows.slice(0, parsed.value.limit) : rows;
        const last = page.at(-1);
        const nextCursor = hasMore && last ? encodeCursor(last) : undefined;
        return c.json({ routines: page.map(presentRoutine), ...(nextCursor ? { nextCursor } : {}) });
    })

    // ── GET /v1/routines/:id ────────────────────────────────────────────────
    .get('/routines/:id', requireScope('routines.read'), async (c) => {
        const { userId } = c.var.apiAuth;
        const id = c.req.param('id');
        const routine = await routinesDAO.findByOwnerAndId(id, userId);
        if (!routine) {
            return c.json({ error: 'routine not found', code: 'not_found' }, 404);
        }
        return c.json(presentRoutine(routine));
    })

    // ── PATCH /v1/routines/:id ──────────────────────────────────────────────
    // Strategy: read the existing routine, merge the (allowlisted) patch on top, hand the full
    // snapshot to the apply pipeline. Zod validates the merged shape — so e.g. clearing
    // `calendarItemTemplate` on a calendar routine fails validation, instead of silently
    // breaking item generation later.
    .patch('/routines/:id', requireScope('routines.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!raw || typeof raw !== 'object') {
            return c.json({ error: 'request body must be a JSON object', code: 'invalid_body' }, 400);
        }
        if (Object.keys(raw).length === 0) {
            return c.json({ error: 'PATCH body must include at least one field', code: 'empty_body' }, 400);
        }
        const writable = checkWritableKeys(raw);
        if (!writable.ok) {
            return c.json({ error: `field "${writable.offending}" cannot be set via the public API`, code: 'forbidden_field' }, 400);
        }
        const existing = await routinesDAO.findByOwnerAndId(id, userId);
        if (!existing) {
            return c.json({ error: 'routine not found', code: 'not_found' }, 404);
        }
        const now = dayjs().toISOString();
        const snapshot = { ...existing, ...raw, updatedTs: now } as RoutineInterface;
        const result = await applyRoutineWrite(userId, tokenId, snapshot, 'update', now);
        if (!result.ok) {
            return c.json(
                { error: result.error.message, code: result.error.code, ...(result.error.path ? { path: result.error.path } : {}) },
                result.error.status,
            );
        }
        return c.json(presentRoutine(snapshot));
    })

    // ── DELETE /v1/routines/:id ─────────────────────────────────────────────
    // The shared apply pipeline hydrates the pre-delete snapshot from DB so the GCal cascade
    // (handled by `applyEntityOp` + `notifyChange`) has the calendar series id it needs to
    // tear down the master event. Idempotent: deleting a missing routine returns 200.
    .delete('/routines/:id', requireScope('routines.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const existing = await routinesDAO.findByOwnerAndId(id, userId);
        if (!existing) {
            return c.json({ ok: true, alreadyDeleted: true });
        }
        await applyAndPublishOperation(
            userId,
            { entityType: 'routine', opType: 'delete', entityId: id, snapshot: null },
            { deviceId: `api:${tokenId}`, strict: true },
        );
        return c.json({ ok: true });
    })

    // ── POST /v1/routines/:id/pause ─────────────────────────────────────────
    // Composite: trash future open items + flip active=false. GCal cap-with-UNTIL is fired
    // downstream by `handleRoutinePush` when the routine update op lands.
    .post('/routines/:id/pause', requireScope('routines.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const result = await pauseRoutine({ userId, tokenId }, id);
        if (!result.ok) {
            return c.json({ error: result.message, code: result.code }, result.status);
        }
        return c.json(presentRoutine(result.routine));
    })

    // ── POST /v1/routines/:id/resume ────────────────────────────────────────
    // Composite: flip active=true and stamp startDate=tomorrow so the on-device generator
    // starts a fresh series (mirrors the existing in-app resume gesture).
    .post('/routines/:id/resume', requireScope('routines.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const result = await resumeRoutine({ userId, tokenId }, id);
        if (!result.ok) {
            return c.json({ error: result.message, code: result.code }, result.status);
        }
        return c.json(presentRoutine(result.routine));
    })

    // ── POST /v1/routines/:id/split ─────────────────────────────────────────
    // Composite: cap the head with UNTIL, delete its future calendar items, create a new tail
    // routine carrying the user's edits. Calendar tails seed their items client-side on next
    // sync (the server-side generator does not exist) — see lib/routineComposites.ts.
    .post('/routines/:id/split', requireScope('routines.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const raw = (await c.req.json().catch(() => null)) as SplitBody | null;
        const parsed = parseSplitBody(raw);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
        }
        try {
            const result = await splitRoutine({ userId, tokenId }, id, parsed.value);
            if (!result.ok) {
                return c.json({ error: result.message, code: result.code }, result.status);
            }
            return c.json({ head: presentRoutine(result.head), tail: presentRoutine(result.tail) }, 201);
        } catch (err) {
            if (err instanceof OperationValidationError) {
                return c.json({ error: err.failure.message, code: err.failure.code, ...(err.failure.path ? { path: err.failure.path } : {}) }, 400);
            }
            throw err;
        }
    });

interface SplitBody {
    splitDate?: unknown;
    tailEdits?: unknown;
}

type SplitBodyError = { code: 'invalid_body' | 'invalid_split_date' | 'invalid_tail_edits'; message: string };

function parseSplitBody(raw: SplitBody | null): { ok: true; value: SplitParams } | { ok: false; error: SplitBodyError } {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { code: 'invalid_body', message: 'request body must be a JSON object' } };
    }
    // Strict dayjs parse: rejects structurally-invalid YYYY-MM-DD strings like "2099-13-45" that
    // a regex would let through. Without this, the downstream `dayjs.utc(...).toISOString()` in
    // `buildTail` throws RangeError → 500.
    if (typeof raw.splitDate !== 'string' || !dayjs(raw.splitDate, 'YYYY-MM-DD', true).isValid()) {
        return { ok: false, error: { code: 'invalid_split_date', message: 'splitDate must be a valid ISO date YYYY-MM-DD' } };
    }
    const value: SplitParams = { splitDate: raw.splitDate };
    if (raw.tailEdits !== undefined) {
        if (raw.tailEdits === null || typeof raw.tailEdits !== 'object' || Array.isArray(raw.tailEdits)) {
            return { ok: false, error: { code: 'invalid_tail_edits', message: 'tailEdits must be an object when provided' } };
        }
        // The structural fields ride through to `splitRoutine` and ultimately `applyAndPublishOperation`,
        // where `RoutineSnapshotSchema` validates the merged shape. We accept the raw bag here.
        // The cast through NonNullable strips the `| undefined` from `SplitParams['tailEdits']` so
        // assignment satisfies `exactOptionalPropertyTypes` (we just narrowed it above).
        value.tailEdits = raw.tailEdits as NonNullable<SplitParams['tailEdits']>;
    }
    return { ok: true, value };
}
