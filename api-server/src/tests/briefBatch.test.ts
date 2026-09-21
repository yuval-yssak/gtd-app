/** Message Batches pipeline (lib/brief/briefBatch.ts) against Mongo with the Anthropic client
 * mocked at the seam: custom_id contract, skip-rule short-circuit, in-flight guard, request shape,
 * per-result harvest routing, CAS/pinned protection, expiry, failure isolation and the fake seam. */
import Anthropic from '@anthropic-ai/sdk';
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import briefBatchesDAO from '../dataAccess/briefBatchesDAO.js';
import briefBatchRequestsDAO from '../dataAccess/briefBatchRequestsDAO.js';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import {
    BRIEF_BATCH_DEVICE_ID,
    BRIEF_BATCH_EXPIRY_HOURS,
    BRIEF_BATCH_REQUEST_TTL_HOURS,
    BRIEF_BATCH_ROW_TTL_DAYS,
    CUSTOM_ID_PATTERN,
    harvestBriefBatches,
    newBriefCustomId,
    submitBriefBatch,
} from '../lib/brief/briefBatch.js';
import { BRIEF_MODEL, buildBriefRequest } from '../lib/brief/briefPrompt.js';
import { briefSourceHash } from '../lib/briefSource.js';
import { writeAuthoredBrief } from '../lib/itemBriefs.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { BriefBatchInterface, BriefBatchRequestInterface, ItemBriefInterface, ItemInterface, OperationInterface } from '../types/entities.js';

const batchesCreate = vi.fn();
const batchesRetrieve = vi.fn();
const batchesResults = vi.fn();
vi.mock('../lib/claude/anthropicClient.js', () => ({
    getAnthropicClient: () => ({ messages: { batches: { create: batchesCreate, retrieve: batchesRetrieve, results: batchesResults } } }),
}));

// Pass-through by default; one test makes a single write fail to prove the stream survives it.
// `vi.hoisted` so the spy exists when the (hoisted) factory runs.
const { upsertBriefRowMock } = vi.hoisted(() => ({ upsertBriefRowMock: vi.fn() }));
vi.mock('../lib/itemBriefs.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../lib/itemBriefs.js')>();
    upsertBriefRowMock.mockImplementation(original.upsertBriefRow);
    return { ...original, upsertBriefRow: (...args: Parameters<typeof original.upsertBriefRow>) => upsertBriefRowMock(...args) };
});

beforeAll(async () => {
    await loadDataAccess('gtd_test_brief_batch');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(['items', 'itemBriefs', 'operations', 'briefBatches', 'briefBatchRequests'].map((name) => db.collection(name).deleteMany({})));
    batchesCreate.mockReset().mockResolvedValue({ id: 'msgbatch_1', processing_status: 'in_progress' });
    batchesRetrieve.mockReset();
    batchesResults.mockReset();
    vi.stubEnv('BRIEF_FAKE_MODEL', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

// ─── Seeds ──────────────────────────────────────────────────────────────────

const USER = 'user-a';
const LONG_NOTES =
    'Expires in March; need photos and the old passport. The consulate only takes appointments on weekday mornings, ' +
    'and the earliest slot is usually three weeks out, so the photos have to be done before booking.';

async function seedItem(overrides: Partial<ItemInterface> = {}): Promise<ItemInterface & { _id: string }> {
    const now = dayjs().toISOString();
    const item: ItemInterface & { _id: string } = {
        _id: `item-${Math.random().toString(36).slice(2)}`,
        user: USER,
        status: 'nextAction',
        title: 'Renew passport',
        notes: LONG_NOTES,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    await itemsDAO.insertOne(item);
    return item;
}

async function seedProcessingBatch(id = 'msgbatch_old', hoursAgo = 1): Promise<BriefBatchInterface> {
    const created = dayjs().subtract(hoursAgo, 'hour');
    const row: BriefBatchInterface = {
        _id: id,
        createdTs: created.toISOString(),
        submittedCount: 1,
        status: 'processing',
        expiresAt: created.add(BRIEF_BATCH_ROW_TTL_DAYS, 'day').toDate(),
    };
    await briefBatchesDAO.insertOne(row);
    return row;
}

async function seedRequest(batchId: string, item: ItemInterface & { _id: string }, sourceHash = briefSourceHash(item.title, item.notes)): Promise<string> {
    const customId = newBriefCustomId();
    const created = dayjs();
    await briefBatchRequestsDAO.insertOne({
        _id: customId,
        batchId,
        user: item.user,
        itemId: item._id,
        sourceHash,
        createdTs: created.toISOString(),
        expiresAt: created.add(BRIEF_BATCH_REQUEST_TTL_HOURS, 'hour').toDate(),
    });
    return customId;
}

/** The TTL spec of the index on `field`, or `undefined` when no such index exists. */
async function ttlSecondsOf(collection: string, field: string): Promise<number | undefined> {
    const indexes = await db.collection(collection).listIndexes().toArray();
    const ttl = indexes.find((index) => index.key?.[field] === 1 && 'expireAfterSeconds' in index);
    return ttl?.expireAfterSeconds;
}

function succeeded(customId: string, brief: string | null) {
    return {
        custom_id: customId,
        result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ brief }) }] } },
    };
}

function errored(customId: string, type: string) {
    return { custom_id: customId, result: { type: 'errored', error: { type: 'error', request_id: 'req', error: { type, message: `${type} happened` } } } };
}

/** Results arrive as an async iterable — and in ANY order, which the tests exploit. */
function resultsStream(lines: unknown[]) {
    batchesResults.mockResolvedValue(
        (async function* () {
            yield* lines;
        })(),
    );
}

async function briefOf(itemId: string): Promise<ItemBriefInterface | null> {
    return itemBriefsDAO.findByOwnerAndId(itemId, USER);
}

async function batchRow(id: string): Promise<BriefBatchInterface | null> {
    return briefBatchesDAO.findOne({ _id: id });
}

// ─── custom_id ──────────────────────────────────────────────────────────────

describe('newBriefCustomId', () => {
    it("fits Anthropic's contract (≤ 64 chars of [A-Za-z0-9_-]) and does not repeat", () => {
        const ids = Array.from({ length: 200 }, newBriefCustomId);
        for (const id of ids) {
            expect(id).toMatch(CUSTOM_ID_PATTERN);
            expect(id.length).toBeLessThanOrEqual(64);
        }
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('round-trips the (user, item, sourceHash) identity through the request row', async () => {
        const item = await seedItem();
        const customId = await seedRequest('msgbatch_rt', item);
        const rows = await briefBatchRequestsDAO.findByBatch('msgbatch_rt');
        expect(rows.get(customId)).toMatchObject({ user: USER, itemId: item._id, sourceHash: briefSourceHash(item.title, item.notes) });
    });
});

// ─── submit ─────────────────────────────────────────────────────────────────

describe('submitBriefBatch', () => {
    it('writes skip rows immediately for short notes and submits only the model-bound targets', async () => {
        const short = await seedItem({ notes: 'too short' });
        const long = await seedItem();

        const summary = await submitBriefBatch({ limit: 100 });

        expect(summary).toEqual({ submitted: 1, skipped: 1, inFlight: false, batchId: 'msgbatch_1' });
        expect(await briefOf(short._id)).toMatchObject({ origin: 'skipped', text: null });
        expect(await briefOf(long._id)).toBeNull();
        expect(batchesCreate).toHaveBeenCalledTimes(1);
        const [call] = batchesCreate.mock.calls;
        if (!call) throw new Error('expected one batches.create call');
        const [params] = call as [{ requests: { custom_id: string; params: unknown }[] }];
        expect(params.requests).toHaveLength(1);
        const [request] = params.requests;
        if (!request) throw new Error('expected one request');
        expect(request.params).toEqual(buildBriefRequest(long));
        expect(request.custom_id).toMatch(CUSTOM_ID_PATTERN);

        const rows = await briefBatchRequestsDAO.findByBatch('msgbatch_1');
        expect(rows.get(request.custom_id)).toMatchObject({
            batchId: 'msgbatch_1',
            user: USER,
            itemId: long._id,
            sourceHash: briefSourceHash(long.title, long.notes),
        });
        expect(await batchRow('msgbatch_1')).toMatchObject({ status: 'processing', submittedCount: 1 });
    });

    it('stamps both rows with a BSON-Date expiresAt that a real TTL index reaps (an ISO string would never fire)', async () => {
        await seedItem();
        const before = dayjs();
        await submitBriefBatch({ limit: 10 });

        const batch = await batchRow('msgbatch_1');
        if (!batch) throw new Error('expected the batch row');
        expect(batch.expiresAt).toBeInstanceOf(Date);
        expect(dayjs(batch.expiresAt).diff(before, 'day', true)).toBeCloseTo(BRIEF_BATCH_ROW_TTL_DAYS, 1);
        const [request] = await briefBatchRequestsDAO.findArray({ batchId: 'msgbatch_1' });
        if (!request) throw new Error('expected the request row');
        expect(request.expiresAt).toBeInstanceOf(Date);
        expect(dayjs(request.expiresAt).diff(before, 'hour', true)).toBeCloseTo(BRIEF_BATCH_REQUEST_TTL_HOURS, 1);
        expect(dayjs(request.expiresAt).diff(dayjs(request.createdTs), 'hour', true)).toBeCloseTo(BRIEF_BATCH_REQUEST_TTL_HOURS, 3);

        expect(await ttlSecondsOf('briefBatches', 'expiresAt')).toBe(0);
        expect(await ttlSecondsOf('briefBatchRequests', 'expiresAt')).toBe(0);
    });

    it('stamps skip rows with the batch device id', async () => {
        const short = await seedItem({ notes: 'too short' });
        await submitBriefBatch({ limit: 10 });
        const ops = await db.collection<OperationInterface>('operations').find({ entityId: short._id }).toArray();
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one op');
        expect(op.deviceId).toBe(BRIEF_BATCH_DEVICE_ID);
    });

    it('does not select or submit anything while a batch is still processing', async () => {
        await seedProcessingBatch();
        const short = await seedItem({ notes: 'too short' });
        await seedItem();

        await expect(submitBriefBatch({ limit: 100 })).resolves.toEqual({ submitted: 0, skipped: 0, inFlight: true });
        expect(batchesCreate).not.toHaveBeenCalled();
        expect(await briefOf(short._id)).toBeNull();
    });

    it('creates no batch when every target was a skip', async () => {
        await seedItem({ notes: 'too short' });
        await expect(submitBriefBatch({ limit: 100 })).resolves.toEqual({ submitted: 0, skipped: 1, inFlight: false });
        expect(batchesCreate).not.toHaveBeenCalled();
        expect(await briefBatchesDAO.countDocuments()).toBe(0);
    });

    it('never briefs a done or trash item — they are not reviewed, so a brief is unreadable spend', async () => {
        await seedItem({ status: 'done' });
        await seedItem({ status: 'trash' });
        await expect(submitBriefBatch({ limit: 100 })).resolves.toEqual({ submitted: 0, skipped: 0, inFlight: false });
        expect(batchesCreate).not.toHaveBeenCalled();
    });

    it('briefs an item revived from trash — a status change alone makes it a target again', async () => {
        const revived = await seedItem({ status: 'trash' });
        await expect(submitBriefBatch({ limit: 100 })).resolves.toMatchObject({ submitted: 0 });
        await itemsDAO.updateOne({ _id: revived._id }, { $set: { status: 'nextAction' } });
        await expect(submitBriefBatch({ limit: 100 })).resolves.toMatchObject({ submitted: 1 });
        const rows = [...(await briefBatchRequestsDAO.findByBatch('msgbatch_1')).values()].map((row) => row.itemId);
        expect(rows).toEqual([revived._id]);
    });

    it('leaves an existing brief on a closed item alone — it is paid for, and survives a revive', async () => {
        const item = await seedItem();
        const customId = await seedRequest('msgbatch_done', item);
        resultsStream([succeeded(customId, 'A one-line brief.')]);
        batchesRetrieve.mockResolvedValue({ id: 'msgbatch_done', processing_status: 'ended' });
        await seedProcessingBatch('msgbatch_done', 0);
        await harvestBriefBatches();
        expect(await briefOf(item._id)).not.toBeNull();

        // Closing the item stops it being targeted but must NOT remove what was already written.
        await itemsDAO.updateOne({ _id: item._id }, { $set: { status: 'done' } });
        await expect(submitBriefBatch({ limit: 100 })).resolves.toMatchObject({ submitted: 0, skipped: 0 });
        expect(await briefOf(item._id)).not.toBeNull();
    });

    it('never targets a pinned brief, stale or not', async () => {
        const pinned = await seedItem();
        await writeAuthoredBrief({ userId: USER, itemId: pinned._id, item: pinned, text: 'mine', origin: 'user', deviceId: 'test' });
        await itemsDAO.updateOne({ _id: pinned._id }, { $set: { notes: `${LONG_NOTES} edited` } });
        await expect(submitBriefBatch({ limit: 100 })).resolves.toMatchObject({ submitted: 0, skipped: 0 });
        expect(batchesCreate).not.toHaveBeenCalled();
    });

    it('honours the limit', async () => {
        await Promise.all(Array.from({ length: 5 }, () => seedItem()));
        await expect(submitBriefBatch({ limit: 3 })).resolves.toMatchObject({ submitted: 3 });
    });

    it('fake mode never touches the SDK, writes [fake] briefs directly and ignores the in-flight guard', async () => {
        vi.stubEnv('BRIEF_FAKE_MODEL', '1');
        await seedProcessingBatch();
        const long = await seedItem();
        const short = await seedItem({ notes: 'too short' });

        await expect(submitBriefBatch({ limit: 100 })).resolves.toEqual({ submitted: 1, skipped: 1, inFlight: false, fake: true });

        expect(batchesCreate).not.toHaveBeenCalled();
        expect(await briefOf(long._id)).toMatchObject({ origin: 'model', model: 'fake', text: '[fake] Expires in March; need photos and the old passport' });
        expect(await briefOf(short._id)).toMatchObject({ origin: 'skipped' });
        expect(await briefBatchesDAO.countDocuments()).toBe(1);
        expect(await briefBatchRequestsDAO.countDocuments()).toBe(0);
    });
});

// ─── harvest ────────────────────────────────────────────────────────────────

describe('harvestBriefBatches', () => {
    it('leaves a young in-progress batch alone and reports it pending', async () => {
        await seedProcessingBatch('msgbatch_young', 1);
        batchesRetrieve.mockResolvedValue({ id: 'msgbatch_young', processing_status: 'in_progress' });
        await expect(harvestBriefBatches()).resolves.toMatchObject({ harvested: 0, pending: 1, expired: 0 });
        expect(await batchRow('msgbatch_young')).toMatchObject({ status: 'processing' });
        expect(batchesResults).not.toHaveBeenCalled();
    });

    it(`marks a batch still processing after ${BRIEF_BATCH_EXPIRY_HOURS} h as expired, logs it and drops its request rows`, async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const item = await seedItem();
        await seedProcessingBatch('msgbatch_stale', BRIEF_BATCH_EXPIRY_HOURS + 1);
        await seedRequest('msgbatch_stale', item);
        batchesRetrieve.mockResolvedValue({ id: 'msgbatch_stale', processing_status: 'in_progress' });

        await expect(harvestBriefBatches()).resolves.toMatchObject({ harvested: 0, pending: 0, expired: 1 });

        expect(await batchRow('msgbatch_stale')).toMatchObject({ status: 'expired' });
        expect(await briefBatchRequestsDAO.countDocuments()).toBe(0);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('msgbatch_stale'));
        // The item is untouched — still a target for the next submit.
        expect(await briefOf(item._id)).toBeNull();
    });

    it('routes every result type by custom_id regardless of order, writes only successes, and records the tallies', async () => {
        const batch = await seedProcessingBatch('msgbatch_done');
        const [ok, nullBrief, invalid, transient, canceled, expired] = await Promise.all(Array.from({ length: 6 }, () => seedItem()));
        if (!ok || !nullBrief || !invalid || !transient || !canceled || !expired) throw new Error('expected six seeded items');
        const ids = {
            ok: await seedRequest(batch._id, ok),
            nullBrief: await seedRequest(batch._id, nullBrief),
            invalid: await seedRequest(batch._id, invalid),
            transient: await seedRequest(batch._id, transient),
            canceled: await seedRequest(batch._id, canceled),
            expired: await seedRequest(batch._id, expired),
        };
        batchesRetrieve.mockResolvedValue({ id: batch._id, processing_status: 'ended' });
        resultsStream([
            { custom_id: 'unknown-custom-id-2', result: { type: 'canceled' } },
            { custom_id: ids.expired, result: { type: 'expired' } },
            errored(ids.transient, 'rate_limit_error'),
            succeeded(ids.ok, 'Passport renewal still blocked on photos.'),
            { custom_id: ids.canceled, result: { type: 'canceled' } },
            errored(ids.invalid, 'invalid_request_error'),
            succeeded(ids.nullBrief, null),
            { custom_id: 'unknown-custom-id', result: { type: 'succeeded', message: { content: [] } } },
        ]);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const summary = await harvestBriefBatches();

        const counts = { succeeded: 2, errored: 2, canceled: 1, expired: 1, discardedStale: 0, pinned: 0, written: 2 };
        expect(summary).toMatchObject({ harvested: 1, pending: 0, expired: 0, failed: 0, errors: 0, resultCounts: counts });
        expect(await briefOf(ok._id)).toMatchObject({ origin: 'model', model: BRIEF_MODEL, text: 'Passport renewal still blocked on photos.' });
        expect(await briefOf(nullBrief._id)).toMatchObject({ origin: 'model', text: null });
        for (const untouched of [invalid, transient, canceled, expired]) {
            expect(await briefOf(untouched._id)).toBeNull();
        }
        expect(await batchRow(batch._id)).toMatchObject({ status: 'harvested', resultCounts: counts, harvestedTs: expect.any(String) });
        expect(await briefBatchRequestsDAO.countDocuments()).toBe(0);
        // The permanent error is logged at error level (resubmitting will not help); unknown ids are
        // summarised in ONE line, not one per result.
        expect(error).toHaveBeenCalledWith(expect.stringContaining('invalid_request_error'));
        expect(warn.mock.calls.filter(([line]) => String(line).includes('no matching request row'))).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored 2 result(s)'));
    });

    it('stamps harvested writes with the batch device id', async () => {
        const batch = await seedProcessingBatch('msgbatch_dev');
        const item = await seedItem();
        const id = await seedRequest(batch._id, item);
        batchesRetrieve.mockResolvedValue({ id: batch._id, processing_status: 'ended' });
        resultsStream([succeeded(id, 'A brief.')]);
        await harvestBriefBatches();
        const ops = await db.collection<OperationInterface>('operations').find({ entityId: item._id }).toArray();
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one op');
        expect(op).toMatchObject({ deviceId: BRIEF_BATCH_DEVICE_ID, entityType: 'itemBrief', opType: 'create' });
    });

    it('discards a success whose item content changed between submit and harvest (the CAS)', async () => {
        const batch = await seedProcessingBatch('msgbatch_cas');
        const item = await seedItem();
        const id = await seedRequest(batch._id, item);
        await itemsDAO.updateOne({ _id: item._id }, { $set: { notes: `${LONG_NOTES} — and now something else entirely.` } });
        batchesRetrieve.mockResolvedValue({ id: batch._id, processing_status: 'ended' });
        resultsStream([succeeded(id, 'Stale brief.')]);

        const summary = await harvestBriefBatches();

        expect(summary.resultCounts).toMatchObject({ succeeded: 1, discardedStale: 1, written: 0 });
        expect(await briefOf(item._id)).toBeNull();
    });

    it('leaves a brief the user authored while the batch was in flight untouched', async () => {
        const batch = await seedProcessingBatch('msgbatch_pin');
        const item = await seedItem();
        const id = await seedRequest(batch._id, item);
        await writeAuthoredBrief({ userId: USER, itemId: item._id, item, text: 'mine', origin: 'user', deviceId: 'test' });
        batchesRetrieve.mockResolvedValue({ id: batch._id, processing_status: 'ended' });
        resultsStream([succeeded(id, 'Model brief.')]);

        const summary = await harvestBriefBatches();

        expect(summary.resultCounts).toMatchObject({ succeeded: 1, pinned: 1, written: 0 });
        expect(await briefOf(item._id)).toMatchObject({ origin: 'user', text: 'mine' });
    });

    it('counts an unusable success payload (refusal, non-JSON) as errored and writes nothing', async () => {
        const batch = await seedProcessingBatch('msgbatch_bad');
        const [refused, garbage] = await Promise.all([seedItem(), seedItem()]);
        if (!refused || !garbage) throw new Error('expected two seeded items');
        const refusedId = await seedRequest(batch._id, refused);
        const garbageId = await seedRequest(batch._id, garbage);
        batchesRetrieve.mockResolvedValue({ id: batch._id, processing_status: 'ended' });
        resultsStream([
            { custom_id: refusedId, result: { type: 'succeeded', message: { stop_reason: 'refusal', content: [] } } },
            { custom_id: garbageId, result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } } },
        ]);

        const summary = await harvestBriefBatches();

        expect(summary.resultCounts).toMatchObject({ succeeded: 2, errored: 2, written: 0 });
        expect(await briefOf(refused._id)).toBeNull();
        expect(await briefOf(garbage._id)).toBeNull();
    });

    it('a write that fails for one result is counted as errored and never aborts the harvest (a poison row cannot stall the pipeline)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const batch = await seedProcessingBatch('msgbatch_poison');
        const [poison, fine] = await Promise.all([seedItem(), seedItem()]);
        if (!poison || !fine) throw new Error('expected two seeded items');
        const poisonId = await seedRequest(batch._id, poison);
        const fineId = await seedRequest(batch._id, fine);
        upsertBriefRowMock.mockImplementationOnce(async () => {
            throw new Error('E11000 duplicate key');
        });
        batchesRetrieve.mockResolvedValue({ id: batch._id, processing_status: 'ended' });
        resultsStream([succeeded(poisonId, 'Poison.'), succeeded(fineId, 'Fine.')]);
        // The spy is never reset (that would drop its pass-through), so count relative to now.
        const writesBefore = upsertBriefRowMock.mock.calls.length;

        const summary = await harvestBriefBatches();

        expect(summary).toMatchObject({ harvested: 1, errors: 0, resultCounts: expect.objectContaining({ succeeded: 2, errored: 1, written: 1 }) });
        expect(await briefOf(poison._id)).toBeNull();
        expect(await briefOf(fine._id)).toMatchObject({ text: 'Fine.' });
        expect(await batchRow(batch._id)).toMatchObject({ status: 'harvested' });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('E11000'));
        // Both results reached the writer: the one-shot failure and the pass-through that followed it.
        expect(upsertBriefRowMock.mock.calls.length - writesBefore).toBe(2);
    });

    it('marks a batch Anthropic no longer knows as failed and keeps a transiently failing one for the next sweep', async () => {
        await seedProcessingBatch('msgbatch_gone');
        await seedProcessingBatch('msgbatch_flaky');
        batchesRetrieve.mockImplementation(async (id: string) => {
            if (id === 'msgbatch_gone') {
                throw new Anthropic.NotFoundError(404, { type: 'error', error: { type: 'not_found_error', message: 'nope' } }, 'nope', new Headers());
            }
            throw new Error('socket hang up');
        });

        await expect(harvestBriefBatches()).resolves.toMatchObject({ harvested: 0, failed: 1, errors: 1 });

        expect(await batchRow('msgbatch_gone')).toMatchObject({ status: 'failed' });
        expect(await batchRow('msgbatch_flaky')).toMatchObject({ status: 'processing' });
    });

    it('frees the in-flight slot for a submit in the same sweep once the batch is harvested', async () => {
        await seedProcessingBatch('msgbatch_prev');
        batchesRetrieve.mockResolvedValue({ id: 'msgbatch_prev', processing_status: 'ended' });
        resultsStream([]);
        await seedItem();

        await harvestBriefBatches();
        await expect(submitBriefBatch({ limit: 10 })).resolves.toMatchObject({ submitted: 1, inFlight: false });
    });

    it('a harvested batch leaves no dangling request rows even when it had none', async () => {
        await seedProcessingBatch('msgbatch_empty');
        batchesRetrieve.mockResolvedValue({ id: 'msgbatch_empty', processing_status: 'ended' });
        resultsStream([]);
        await harvestBriefBatches();
        const rows: BriefBatchRequestInterface[] = await briefBatchRequestsDAO.findArray({});
        expect(rows).toEqual([]);
    });
});
