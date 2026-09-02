import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordOperation, warnOnFutureUpdatedTs } from '../lib/operationHelpers.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('operations').deleteMany({});
});

function makeSnapshot(updatedTs: string): ItemInterface {
    return {
        _id: 'item-warn-test',
        user: 'user-warn-test',
        status: 'inbox',
        title: 'Test item',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('warnOnFutureUpdatedTs', () => {
    it('warns when snapshot.updatedTs is more than 5 minutes ahead of the op clock', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const now = dayjs().toISOString();
        const future = dayjs(now).add(6, 'minute').toISOString();
        warnOnFutureUpdatedTs({ entityType: 'item', entityId: 'item-warn-test', snapshot: makeSnapshot(future), opType: 'update', now });
        expect(warn).toHaveBeenCalledOnce();
    });

    it('stays silent within the 5-minute tolerance and for past timestamps', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const now = dayjs().toISOString();
        const slightlyAhead = dayjs(now).add(4, 'minute').toISOString();
        warnOnFutureUpdatedTs({ entityType: 'item', entityId: 'item-warn-test', snapshot: makeSnapshot(slightlyAhead), opType: 'update', now });
        const past = dayjs(now).subtract(1, 'day').toISOString();
        warnOnFutureUpdatedTs({ entityType: 'item', entityId: 'item-warn-test', snapshot: makeSnapshot(past), opType: 'update', now });
        expect(warn).not.toHaveBeenCalled();
    });

    it('stays silent at exactly the 5-minute boundary (isAfter is strict)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const now = dayjs().toISOString();
        const boundary = dayjs(now).add(5, 'minute').toISOString();
        warnOnFutureUpdatedTs({ entityType: 'item', entityId: 'item-warn-test', snapshot: makeSnapshot(boundary), opType: 'update', now });
        expect(warn).not.toHaveBeenCalled();
    });

    it('stays silent for snapshot-less ops (delete)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        warnOnFutureUpdatedTs({ entityType: 'item', entityId: 'item-warn-test', snapshot: null, opType: 'delete', now: dayjs().toISOString() });
        expect(warn).not.toHaveBeenCalled();
    });

    it('fires from recordOperation itself, not just when called directly', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const now = dayjs().toISOString();
        await recordOperation('user-warn-test', {
            entityType: 'item',
            entityId: 'item-warn-test',
            snapshot: makeSnapshot(dayjs(now).add(1, 'hour').toISOString()),
            opType: 'update',
            now,
        });
        expect(warn).toHaveBeenCalledOnce();
    });
});

describe('recordOperation op identity (stale-run-clock op-skip regression)', () => {
    it('stamps ts at write time, NOT from the caller-supplied run clock', async () => {
        // A webhook/full-sync run captures its clock at run start and can record ops minutes
        // later. Stamping that stale clock onto `ts` put the op behind devices' forward-only pull
        // cursors — permanently undelivered. `ts` must come from the wall clock at write time.
        const staleRunClock = dayjs().subtract(2, 'minute').toISOString();
        const before = dayjs().toISOString();
        const op = await recordOperation('user-warn-test', {
            entityType: 'item',
            entityId: 'item-warn-test',
            snapshot: makeSnapshot(staleRunClock),
            opType: 'update',
            now: staleRunClock,
        });
        expect(op.ts >= before).toBe(true);
        // The snapshot's entity clock is untouched — only the transport ordering is re-anchored.
        expect(op.snapshot?.updatedTs).toBe(staleRunClock);
    });

    it('same-ms ops get monotonically increasing _ids in call order', async () => {
        const now = dayjs().toISOString();
        const first = await recordOperation('user-warn-test', {
            entityType: 'item',
            entityId: 'entity-a',
            snapshot: makeSnapshot(now),
            opType: 'update',
            now,
        });
        const second = await recordOperation('user-warn-test', {
            entityType: 'item',
            entityId: 'entity-b',
            snapshot: makeSnapshot(now),
            opType: 'update',
            now,
        });
        // Whether or not the two calls share a millisecond, `(ts, _id)` must order them by call
        // order — random-UUID ids made same-ms tie order arbitrary, so devices replaying the log
        // could apply two same-ms writes to one entity in the opposite order the server did.
        expect(second.ts >= first.ts).toBe(true);
        expect(second._id > first._id).toBe(true);
    });
});
