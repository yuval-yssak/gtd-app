import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be hoisted before the importing module — vitest hoists `vi.mock(...)` calls.
vi.mock('#api/syncApi', async () => await import('../api/syncApi.mock.ts'));
vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

// Stub out the multi-user orchestrator — we just need to assert it gets called once after a
// successful reassign. The full per-user pull path is exercised in multiUserSync.test.ts.
vi.mock('../db/multiUserSync', () => ({
    syncAllLoggedInUsers: vi.fn(async () => undefined),
}));

import { reassignEntityOnServer } from '#api/syncApi';
import { syncAllLoggedInUsers } from '../db/multiUserSync';
import { reassignEntity } from '../db/reassignMutations';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    vi.clearAllMocks();
    db.close();
});

describe('reassignEntity (client mutation helper)', () => {
    it('forwards the params verbatim to the server endpoint', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: true });
        await reassignEntity(db, { entityType: 'item', entityId: 'item-1', fromUserId: 'a', toUserId: 'b' });
        expect(reassignEntityOnServer).toHaveBeenCalledWith({ entityType: 'item', entityId: 'item-1', fromUserId: 'a', toUserId: 'b' });
    });

    it('triggers syncAllLoggedInUsers on success so both source + target SSE channels pull immediately', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: true });
        await reassignEntity(db, { entityType: 'person', entityId: 'p-1', fromUserId: 'a', toUserId: 'b' });
        expect(syncAllLoggedInUsers).toHaveBeenCalledTimes(1);
        expect(syncAllLoggedInUsers).toHaveBeenCalledWith(db);
    });

    it('does NOT trigger syncAllLoggedInUsers when the server returns an error', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: false, status: 400, error: 'nope' });
        const result = await reassignEntity(db, { entityType: 'item', entityId: 'item-1', fromUserId: 'a', toUserId: 'b' });
        expect(result).toEqual({ ok: false, status: 400, error: 'nope' });
        expect(syncAllLoggedInUsers).not.toHaveBeenCalled();
    });

    it('passes targetCalendar through unchanged when provided', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: true });
        await reassignEntity(db, {
            entityType: 'item',
            entityId: 'cal-item',
            fromUserId: 'a',
            toUserId: 'b',
            targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
        });
        expect(reassignEntityOnServer).toHaveBeenCalledWith(expect.objectContaining({ targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' } }));
    });

    it('returns the crossUserReferences payload from the server when reporting cross-user refs', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: true, crossUserReferences: { peopleIds: ['ref-1'] } });
        const result = await reassignEntity(db, { entityType: 'person', entityId: 'p', fromUserId: 'a', toUserId: 'b' });
        if (!result.ok) {
            throw new Error('expected success');
        }
        expect(result.crossUserReferences?.peopleIds).toEqual(['ref-1']);
    });
});
