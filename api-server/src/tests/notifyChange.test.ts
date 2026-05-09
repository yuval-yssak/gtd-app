/** Pins the contract that a transient throw from `notifyViaWebPush` cannot abort the calling
 * pipeline. Pre-fix, a Mongo blip on `pushSubscriptionsDAO.findSubscribedDevicesForUser` propagated
 * out of `notifyChange`, aborting `applyAndPublishOperation` mid-call — leaving the entity persisted
 * but, in cross-account reassign, the *target-create* leg never running (deleted on source, never
 * created on target). The fix wraps the awaited `notifyViaWebPush` leg in try/catch, logs, and
 * continues so SSE / GCal / webhook fan-out still fire and the caller still resolves.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyChange, notifyChanges } from '../lib/notifyChange.js';
import * as sseConnections from '../lib/sseConnections.js';
import * as webPush from '../lib/webPush.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { OperationInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('webhookSubscriptions').deleteMany({}), db.collection('webhookDeliveries').deleteMany({})]);
    vi.restoreAllMocks();
});

const sampleOp: OperationInterface = {
    _id: 'op-1',
    user: 'user-notify-test',
    deviceId: 'api:tok-x',
    ts: '2026-05-09T10:00:00.000Z',
    entityType: 'item',
    entityId: 'item-1',
    opType: 'create',
    snapshot: {
        _id: 'item-1',
        user: 'user-notify-test',
        status: 'inbox',
        title: 'hello',
        createdTs: '2026-05-09T10:00:00.000Z',
        updatedTs: '2026-05-09T10:00:00.000Z',
    },
};

describe('notifyChange — notifyViaWebPush failure handling', () => {
    it('swallows a thrown notifyViaWebPush, logs the error, and still fires the SSE leg', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        // The pre-fix failure mode: a transient Mongo blip on the subscription lookup throws.
        vi.spyOn(webPush, 'notifyViaWebPush').mockRejectedValueOnce(new Error('mongo blip'));

        await expect(notifyChange(sampleOp)).resolves.toBeUndefined();

        // SSE fires before web push, so it should have happened regardless. Pin the contract.
        expect(sseSpy).toHaveBeenCalledTimes(1);
        // The error is logged with a recognisable prefix so ops can grep for it.
        const tag = errSpy.mock.calls.find((call) => typeof call[0] === 'string' && (call[0] as string).startsWith('[notify-change] notifyViaWebPush failed'));
        expect(tag).toBeDefined();
    });

    it('notifyChanges (batch variant) also swallows a thrown notifyViaWebPush', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        vi.spyOn(webPush, 'notifyViaWebPush').mockRejectedValueOnce(new Error('mongo blip'));

        await expect(notifyChanges([sampleOp, { ...sampleOp, _id: 'op-2', entityId: 'item-2' }])).resolves.toBeUndefined();

        // SSE fires once with the latest ts (batch contract).
        expect(sseSpy).toHaveBeenCalledTimes(1);
        const tag = errSpy.mock.calls.find((call) => typeof call[0] === 'string' && (call[0] as string).startsWith('[notify-change] notifyViaWebPush failed'));
        expect(tag).toBeDefined();
    });
});
