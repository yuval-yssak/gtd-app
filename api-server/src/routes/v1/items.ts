import { createHash, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import type { Filter } from 'mongodb';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import routinesDAO from '../../dataAccess/routinesDAO.js';
import { applyAndPublishOperation, OperationValidationError } from '../../lib/applyOperation.js';
import { advanceRoutineAfterDisposal } from '../../lib/routineItemGeneration.js';
import { STATUS_FIELD_MATRIX, STATUS_SPECIFIC_FIELD_LIST } from '../../schemas/operations/item.js';
import { type ItemInterface, ItemStatus } from '../../types/entities.js';
import { presentItem } from './projections/item.js';

// 24h content-dedupe window: covers retries / double-taps without collapsing genuine recurring
// captures. Callers wanting strict idempotency should provide externalId instead.
const CONTENT_DEDUPE_WINDOW_HOURS = 24;

// Bulk import limits (issue #19 step 6). Tuned to keep a single request bounded — anything
// larger should be chunked client-side.
const MAX_BULK_ITEMS = 5_000;
const DEFAULT_BULK_CHUNK_SIZE = 100;
const MAX_BULK_CHUNK_SIZE = 500;
// Statuses from which `POST /v1/items/:id/complete` is allowed to move an item to `done`.
// `trash` is intentionally not in this list: trashing belongs in the in-app UI because there is
// no /v1 restore endpoint to undo it. The same gate exists on `PATCH /v1/items/:id` —
// `{status: 'trash'}` returns 409 invalid_transition.
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

/** Mongo duplicate-key error code. Surfaces from inserts that violate the (user, externalId) unique index. */
function isDuplicateKeyError(err: unknown): boolean {
    return err instanceof Error && 'code' in err && (err as { code: number }).code === 11000;
}

/**
 * Persists a new inbox item via the shared apply pipeline: insert → log op → fan out (SSE, push,
 * GCal pushback, webhook). The (user, externalId) sparse-unique index can still raise E11000
 * under concurrent inserts — `resolveCreateItem` catches that and resolves to the race-winner.
 */
async function persistNewInboxItem(item: ItemInterface, tokenId: string): Promise<ItemInterface> {
    await itemsDAO.insertOne(item);
    await applyAndPublishOperation(
        item.user,
        { entityType: 'item', opType: 'create', entityId: item._id ?? '', snapshot: item },
        { deviceId: `api:${tokenId}`, now: item.updatedTs },
    );
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

interface BulkBody {
    items?: unknown;
    chunkSize?: unknown;
}

interface BulkItemRequest {
    title?: unknown;
    notes?: unknown;
    externalId?: unknown;
}

interface BulkItemResult {
    externalId: string;
    status: 'created' | 'replayed' | 'failed';
    _id?: string;
    error?: string;
    code?: string;
}

interface BulkResponse {
    results: BulkItemResult[];
    counts: { created: number; replayed: number; failed: number };
}

interface BulkContext {
    userId: string;
    tokenId: string;
    items: unknown[];
    chunkSize: number;
}

/** Coerces a caller-provided chunkSize to the supported range, applying the default when missing. */
function clampBulkChunkSize(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        return DEFAULT_BULK_CHUNK_SIZE;
    }
    return Math.min(raw, MAX_BULK_CHUNK_SIZE);
}

/**
 * Validates a single bulk item. Bulk imports require `externalId` on every item — re-running
 * the import after a partial failure must be idempotent, and that requires a stable per-item key.
 */
function parseBulkItem(raw: BulkItemRequest): { ok: true; value: ParsedCreateBody & { externalId: string } } | { ok: false; error: BulkItemResult } {
    if (raw.externalId === undefined || typeof raw.externalId !== 'string' || raw.externalId.trim() === '') {
        return {
            ok: false,
            error: {
                externalId: typeof raw.externalId === 'string' ? raw.externalId : '',
                status: 'failed',
                code: 'externalId_required',
                error: 'bulk imports require an externalId on every item',
            },
        };
    }
    const externalId = raw.externalId.trim();
    if (typeof raw.title !== 'string' || raw.title.trim() === '') {
        return { ok: false, error: { externalId, status: 'failed', code: 'invalid_title', error: 'title must be a non-empty string' } };
    }
    if (raw.notes !== undefined && typeof raw.notes !== 'string') {
        return { ok: false, error: { externalId, status: 'failed', code: 'invalid_notes', error: 'notes must be a string when provided' } };
    }
    const value: ParsedCreateBody & { externalId: string } = { title: raw.title.trim(), externalId };
    if (raw.notes !== undefined) value.notes = raw.notes;
    return { ok: true, value };
}

/** Processes a single item — pre-validated — and reports its outcome. Failures here are
 * persistence-level (Mongo unavailable, etc.); validation failures never reach this path. */
async function importOneItem(ctx: { userId: string; tokenId: string; body: ParsedCreateBody & { externalId: string } }): Promise<BulkItemResult> {
    try {
        const { item, replayed } = await resolveCreateItem({ userId: ctx.userId, tokenId: ctx.tokenId, body: ctx.body });
        // resolveCreateItem assigns `_id: randomUUID()` to every persisted item, and pre-existing
        // matches always come from Mongo with `_id` populated, so the optional in ItemInterface._id
        // never applies on this path. Default to '' defensively rather than spreading undefined.
        return { externalId: ctx.body.externalId, status: replayed ? 'replayed' : 'created', _id: item._id ?? '' };
    } catch (err) {
        return {
            externalId: ctx.body.externalId,
            status: 'failed',
            code: 'persistence_failed',
            error: err instanceof Error ? err.message : 'unknown error',
        };
    }
}

/**
 * Validates each row, then processes the batch in chunks. Within a chunk, items are processed in
 * parallel via Promise.all. Across chunks, processing is sequential so a flood of concurrent
 * Mongo connections can't blow up under a 5,000-item import.
 */
async function processBulkImport(ctx: BulkContext): Promise<BulkResponse> {
    const validated: Array<{ ok: true; body: ParsedCreateBody & { externalId: string } } | { ok: false; error: BulkItemResult }> = ctx.items.map((row) => {
        const parsed = parseBulkItem((row ?? {}) as BulkItemRequest);
        return parsed.ok ? { ok: true, body: parsed.value } : { ok: false, error: parsed.error };
    });
    const results: BulkItemResult[] = [];
    for (let chunkStart = 0; chunkStart < validated.length; chunkStart += ctx.chunkSize) {
        const chunkEnd = Math.min(chunkStart + ctx.chunkSize, validated.length);
        const chunkResults = await Promise.all(
            validated.slice(chunkStart, chunkEnd).map(async (entry) => {
                if (!entry.ok) {
                    return entry.error;
                }
                return importOneItem({ userId: ctx.userId, tokenId: ctx.tokenId, body: entry.body });
            }),
        );
        results.push(...chunkResults);
    }
    const counts = results.reduce(
        (acc, r) => {
            acc[r.status] += 1;
            return acc;
        },
        { created: 0, replayed: 0, failed: 0 },
    );
    return { results, counts };
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

/** Marks an item done if allowed; idempotent for already-done items. */
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
    // `done` items strip status-specific fields (energy/timeStart/etc) so the snapshot conforms
    // to the status→field matrix. The shared apply pipeline enforces this in strict-mode after
    // the audit lands; doing it here keeps the existing tests green.
    const now = dayjs().toISOString();
    const updated: ItemInterface = sanitizeForStatus({ ...existing, status: 'done', updatedTs: now });
    await applyAndPublishOperation(userId, { entityType: 'item', opType: 'update', entityId: itemId, snapshot: updated }, { deviceId: `api:${tokenId}`, now });
    // If the item belonged to an active nextAction routine, advance the series by generating the
    // next occurrence's item. Mirrors the client-side `maybeCreateNextRoutineItem` so completing
    // a routine-linked item via the public API doesn't leave the series stranded. The helper is
    // a no-op for non-routine / non-nextAction / inactive routines and swallows its own errors.
    await maybeAdvanceRoutineForItem(existing, { userId, tokenId });
    return { ok: true, item: updated, alreadyDone: false };
}

/**
 * If the freshly-disposed item is tied to a nextAction routine, run the server-side generator to
 * produce the next occurrence. Resolves the routine snapshot via the DAO (the item only carries
 * the routineId, not the routine itself) and hands off to `advanceRoutineAfterDisposal`.
 * Errors inside the generator are already logged + swallowed there — `await` is still used so the
 * fan-out has settled before the request returns.
 */
async function maybeAdvanceRoutineForItem(item: ItemInterface, ctx: { userId: string; tokenId: string }): Promise<void> {
    if (!item.routineId) {
        return;
    }
    const routine = await routinesDAO.findByOwnerAndId(item.routineId, ctx.userId);
    if (!routine || !routine.active) {
        return;
    }
    await advanceRoutineAfterDisposal({ userId: ctx.userId, tokenId: ctx.tokenId }, routine, dayjs().toDate());
}

// ── PATCH /v1/items/:id (full-surface update) ──────────────────────────────────────────────
//
// Phase 3 broadened this from a clarify-only handler to a general update surface: any status
// transition allowed by the matrix (inbox → nextAction/waitingFor/somedayMaybe/calendar/done/trash,
// nextAction → calendar, calendar → done, etc.) and any user-settable field including `title`,
// `timeStart`/`timeEnd` for calendar items, etc. The route layer just narrows the writable-key
// set; the apply pipeline's `strict: true` mode enforces every type, the status×field matrix,
// and `floatingDateTime` rules via `RoutineSnapshotSchema`/`ItemSnapshotSchema`.
//
// Requires the `items.write` scope. Tokens minted before the Phase 2 scope extension carry
// the legacy `items.clarify` scope; `bearerMiddleware` backfills it to `items.write` in-memory.

// User-settable fields. Server-managed (`_id`, `user`, `createdTs`, `updatedTs`, `routineId`,
// `contentHash`, `lastPushedToGCalTs`, `lastSyncedFromGCalTs`, `lastSyncedNotes`, `externalId`)
// are intentionally excluded — the route layer rejects them as `forbidden_field` before Zod
// would (the snapshot schema is `.strict()` so it would also reject, but a friendlier route-level
// error helps integrations debug). `routineId` cannot be set via the public API — items born of
// a routine are server-generated; reassigning by hand would silently desynchronize the routine's
// generation cursor.
const PATCH_WRITABLE_FIELDS = new Set<keyof ItemInterface>([
    'status',
    'title',
    'notes',
    'workContextIds',
    'peopleIds',
    'waitingForPersonId',
    'expectedBy',
    'ignoreBefore',
    'timeStart',
    'timeEnd',
    'calendarEventId',
    'calendarIntegrationId',
    'calendarSyncConfigId',
    'energy',
    'time',
    'focus',
    'urgent',
]);

type PatchError = { status: 400 | 404 | 409; code: string; message: string; path?: ReadonlyArray<string | number>; extra?: { status: string; field: string } };

interface PatchContext {
    userId: string;
    tokenId: string;
    itemId: string;
    raw: Record<string, unknown>;
}

type PatchResult = { ok: true; item: ItemInterface } | { ok: false; error: PatchError };

/**
 * Applies the patch to the existing item via the shared apply pipeline. The pipeline's strict-
 * mode Zod validation is the single source of truth for which transitions and field combinations
 * are valid — the route layer only filters out non-writable keys (e.g. caller-supplied `user`).
 *
 * Status transitions are no longer restricted to inbox-only. The matrix in
 * `schemas/operations/item.ts` enforces the destination status's field set; the apply pipeline
 * stamps `user`/`updatedTs` and `applyEntityOp`'s LWW guard handles concurrent writes.
 */
async function patchItem({ userId, tokenId, itemId, raw }: PatchContext): Promise<PatchResult> {
    if (Object.keys(raw).length === 0) {
        return { ok: false, error: { status: 400, code: 'empty_body', message: 'PATCH body must include at least one field' } };
    }
    for (const key of Object.keys(raw)) {
        if (!PATCH_WRITABLE_FIELDS.has(key as keyof ItemInterface)) {
            return { ok: false, error: { status: 400, code: 'forbidden_field', message: `field "${key}" cannot be set via the public API` } };
        }
    }
    // Trash transitions stay out of the public API on purpose. Once an item is trashed the only
    // way back is the in-app UI (no /v1 restore endpoint exists today), so silently letting
    // callers PATCH `{status: 'trash'}` would create unrecoverable rows for headless integrations.
    // Mirrors the same intent that gates trash out of POST /v1/items/:id/complete.
    //
    // Note on routine advancement: because no public-API trash transition exists, there is no
    // server-side `advanceRoutineAfterDisposal` call for trashes. The only way an item reaches
    // `trash` server-side is via `/v1/operations/batch` (replay of a client-originated trash op),
    // and triggering routine advancement on replay would double-create a tail item — the client
    // already ran its own `maybeCreateNextRoutineItem` when it staged the trash op locally.
    if (raw['status'] === 'trash') {
        return {
            ok: false,
            error: { status: 409, code: 'invalid_transition', message: 'PATCH cannot transition to status "trash" — undeleting requires the in-app UI' },
        };
    }
    const existing = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!existing) {
        return { ok: false, error: { status: 404, code: 'not_found', message: 'item not found' } };
    }
    const now = dayjs().toISOString();
    // Merge raw onto existing, then sanitize fields that came *from existing* but no longer fit
    // the target status. Fields the caller explicitly supplied stay in the snapshot — if they
    // violate the matrix, Zod surfaces a `status_field_violation` 400 rather than silently
    // dropping the caller's intent. (The old clarify-only handler silently sanitized everything,
    // which masked client-side bugs.)
    // The cast through `ItemInterface` is a type-level lie at the merge boundary — `raw` is
    // structurally `Record<string, unknown>` after the writable-key filter. Safety relies on
    // (a) `PATCH_WRITABLE_FIELDS` having filtered non-ItemInterface keys, and (b) the apply
    // pipeline's strict-mode Zod check rejecting any remaining shape errors.
    const merged = { ...existing, ...raw, updatedTs: now } as ItemInterface;
    const updated = sanitizeStaleFields(merged, raw);
    try {
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: itemId, snapshot: updated },
            { deviceId: `api:${tokenId}`, now, strict: true },
        );
    } catch (err) {
        if (err instanceof OperationValidationError) {
            return {
                ok: false,
                error: {
                    status: 400,
                    code: err.failure.code,
                    message: err.failure.message,
                    ...(err.failure.path ? { path: err.failure.path } : {}),
                    // Propagate `extra: { status, field }` for status_field_violation so callers
                    // can programmatically branch on the offending matrix cell.
                    ...(err.failure.code === 'status_field_violation' && err.failure.extra ? { extra: err.failure.extra } : {}),
                },
            };
        }
        throw err;
    }
    // PATCH→done parity with POST /complete: when a routine-linked item is patched to `done` (and
    // wasn't already done), advance the series. Skipped on already-done items so a re-PATCH from
    // done→done doesn't duplicate the tail. Trash transitions are blocked above, so the only
    // disposal a PATCH can produce is `done`.
    if (updated.status === 'done' && existing.status !== 'done') {
        await maybeAdvanceRoutineForItem(existing, { userId, tokenId });
    }
    return { ok: true, item: updated };
}

/**
 * Strips status-specific fields that don't belong on the new status, BUT only when those
 * fields came from the existing row (not the caller's patch). Caller-supplied incompatible
 * fields stay in the snapshot so Zod can surface a `status_field_violation` 400 — silently
 * dropping the caller's intent would mask client bugs (the regression that the old
 * `findIncompatibleField` guarded against).
 *
 * `done` and `trash` are archival — they accept all status-specific fields per the matrix,
 * so this is a no-op for transitions to those states (preserves audit-trail metadata like
 * a completed routine instance's `timeStart`).
 */
function sanitizeStaleFields(merged: ItemInterface, callerRaw: Record<string, unknown>): ItemInterface {
    const out: ItemInterface = { ...merged };
    const allowed = STATUS_FIELD_MATRIX[merged.status];
    for (const field of STATUS_SPECIFIC_FIELD_LIST) {
        if (allowed.has(field)) {
            continue;
        }
        // The field is not allowed under the target status. Strip it ONLY if it came from the
        // existing row — leaving caller-supplied incompatible fields lets Zod 400 them.
        if (callerRaw[field] === undefined) {
            delete (out as unknown as Record<string, unknown>)[field];
        }
    }
    return out;
}

/**
 * Used by `completeItem` for the POST /complete shortcut. The caller explicitly asked for a
 * complete, so all stale fields are dropped (no caller-supplied conflicts possible).
 */
function sanitizeForStatus(item: ItemInterface): ItemInterface {
    const out: ItemInterface = { ...item };
    const allowed = STATUS_FIELD_MATRIX[item.status];
    for (const field of STATUS_SPECIFIC_FIELD_LIST) {
        if (!allowed.has(field)) {
            delete (out as unknown as Record<string, unknown>)[field];
        }
    }
    return out;
}

export const v1ItemsRoutes = new Hono<{ Variables: BearerVariables }>()
    // authenticateBearer also consumes from the IP-keyed anon bucket on failed auth, so a flood
    // of bad-credential calls can't keep hammering tokenHash lookups. Successful auth skips the
    // anon bucket and uses the tokenId-keyed limiter below instead.
    .use('*', authenticateBearer)
    // Per-token limiter runs AFTER auth so it has tokenId to scope by. Read and write buckets
    // are independent (see `rateLimitMiddleware.ts`).
    .use('*', authenticatedRateLimit())

    // ── POST /v1/items/bulk — migration import ──────────────────────────────
    // Mounted before /items so Hono's POST /items handler doesn't shadow this on path-collision.
    .post('/items/bulk', requireScope('items.capture'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const raw = (await c.req.json().catch(() => null)) as BulkBody | null;
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
            return c.json({ error: 'request body must be { items: [...] }', code: 'invalid_body' }, 400);
        }
        if (raw.items.length === 0) {
            return c.json({ error: 'items must not be empty', code: 'invalid_body' }, 400);
        }
        if (raw.items.length > MAX_BULK_ITEMS) {
            return c.json({ error: `bulk imports are capped at ${MAX_BULK_ITEMS} items per request`, code: 'too_many_items' }, 413);
        }
        const chunkSize = clampBulkChunkSize(raw.chunkSize);
        const result = await processBulkImport({ userId, tokenId, items: raw.items, chunkSize });
        return c.json(result);
    })

    // ── POST /v1/items — capture an inbox item ──────────────────────────────
    .post('/items', requireScope('items.capture'), async (c) => {
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
    .get('/items', requireScope('items.read'), async (c) => {
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
    .get('/items/:id', requireScope('items.read'), async (c) => {
        const { userId } = c.var.apiAuth;
        const id = c.req.param('id');
        const item = await itemsDAO.findByOwnerAndId(id, userId);
        if (!item) {
            return c.json({ error: 'item not found', code: 'not_found' }, 404);
        }
        return c.json(presentItem(item));
    })

    // ── PATCH /v1/items/:id — full-surface update ───────────────────────────
    .patch('/items/:id', requireScope('items.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const id = c.req.param('id');
        const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return c.json({ error: 'request body must be a JSON object', code: 'invalid_body' }, 400);
        }
        const result = await patchItem({ userId, tokenId, itemId: id, raw });
        if (!result.ok) {
            return c.json(
                {
                    error: result.error.message,
                    code: result.error.code,
                    ...(result.error.path ? { path: result.error.path } : {}),
                    ...(result.error.extra ? { extra: result.error.extra } : {}),
                },
                result.error.status,
            );
        }
        return c.json(presentItem(result.item));
    })

    // ── POST /v1/items/:id/complete ─────────────────────────────────────────
    .post('/items/:id/complete', requireScope('items.write'), async (c) => {
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
