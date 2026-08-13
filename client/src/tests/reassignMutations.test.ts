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

// Mock the offline probe so tests can flip connectivity without a browser navigator.
vi.mock('../lib/onlineStatus', () => ({
    isBrowserOffline: vi.fn(() => false),
}));

import { reassignEntityOnServer } from '#api/syncApi';
import { syncAllLoggedInUsers } from '../db/multiUserSync';
import { attemptReassign, offlineReassignMessage, reassignEntity } from '../db/reassignMutations';
import { isBrowserOffline } from '../lib/onlineStatus';
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

    it('forwards editPatch end-to-end to the server endpoint', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: true });
        await reassignEntity(db, {
            entityType: 'item',
            entityId: 'item-1',
            fromUserId: 'a',
            toUserId: 'b',
            editPatch: { title: 'Renamed', urgent: true, workContextIds: ['ctx-1'] },
        });
        expect(reassignEntityOnServer).toHaveBeenCalledWith(
            expect.objectContaining({
                editPatch: { title: 'Renamed', urgent: true, workContextIds: ['ctx-1'] },
            }),
        );
    });

    it('forwards editRoutinePatch end-to-end to the server endpoint', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: true });
        await reassignEntity(db, {
            entityType: 'routine',
            entityId: 'r-1',
            fromUserId: 'a',
            toUserId: 'b',
            editRoutinePatch: { title: 'Renamed', rrule: 'FREQ=DAILY' },
        });
        expect(reassignEntityOnServer).toHaveBeenCalledWith(
            expect.objectContaining({
                editRoutinePatch: { title: 'Renamed', rrule: 'FREQ=DAILY' },
            }),
        );
    });
});

describe('attemptReassign (outcome mapping)', () => {
    const PARAMS = { entityType: 'person', entityId: 'p-1', fromUserId: 'a', toUserId: 'b' } as const;

    it('returns ok on server success', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: true });
        const outcome = await attemptReassign(db, PARAMS, 'Dana');
        expect(outcome).toEqual({ ok: true });
    });

    it('blocks up front while offline — no network call is fired', async () => {
        vi.mocked(isBrowserOffline).mockReturnValueOnce(true);
        const outcome = await attemptReassign(db, PARAMS, 'Dana');
        expect(outcome).toEqual({ ok: false, message: offlineReassignMessage('Dana') });
        expect(reassignEntityOnServer).not.toHaveBeenCalled();
    });

    it('maps a server rejection to a labeled message instead of a false success', async () => {
        vi.mocked(reassignEntityOnServer).mockResolvedValueOnce({ ok: false, status: 403, error: 'not a device session' });
        const outcome = await attemptReassign(db, PARAMS, 'Dana');
        expect(outcome).toEqual({ ok: false, message: 'Couldn\'t move "Dana" — not a device session' });
    });

    it('maps a network throw (fetch rejection) to a connection message instead of an unhandled rejection', async () => {
        vi.mocked(reassignEntityOnServer).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const outcome = await attemptReassign(db, PARAMS, 'Dana');
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
            throw new Error('expected failure outcome');
        }
        expect(outcome.message).toBe('Couldn\'t move "Dana" — check your connection and try again.');
        expect(syncAllLoggedInUsers).not.toHaveBeenCalled();
    });
});
