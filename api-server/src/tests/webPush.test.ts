/** Tests for reactive push subscription cleanup on sendNotification failure. */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Set VAPID env vars before webPush.ts captures them at module load
vi.hoisted(() => {
    process.env.VAPID_PUBLIC_KEY = 'test-vapid-public';
    process.env.VAPID_PRIVATE_KEY = 'test-vapid-private';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
});

vi.mock('web-push', () => ({
    default: {
        setVapidDetails: vi.fn(),
        sendNotification: vi.fn(),
    },
}));

import webPush from 'web-push';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import { notifyViaWebPush } from '../lib/webPush.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { OperationInterface } from '../types/entities.js';

const mockSendNotification = vi.mocked(webPush.sendNotification);

const TEST_USER = 'test-user-id';

function makePushSub(deviceId: string) {
    return {
        _id: deviceId,
        user: TEST_USER,
        endpoint: `https://push.example.com/${deviceId}`,
        keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
        updatedTs: dayjs().toISOString(),
    };
}

function makeOp(overrides: Partial<OperationInterface> = {}): OperationInterface {
    return {
        _id: crypto.randomUUID(),
        user: TEST_USER,
        deviceId: 'other-device',
        ts: dayjs().toISOString(),
        entityType: 'item',
        entityId: crypto.randomUUID(),
        opType: 'create',
        snapshot: { _id: 'x', user: TEST_USER, status: 'inbox', title: 'Test', createdTs: '', updatedTs: '' },
        ...overrides,
    };
}

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('pushSubscriptions').deleteMany({}), db.collection('deviceUsers').deleteMany({})]);
    mockSendNotification.mockReset();
});

// notifyViaWebPush now resolves target devices via the deviceUsers join, so seed BOTH the
// subscription row and the (deviceId, userId) join row for every device we expect to push to.
async function seedSubscribedDevice(deviceId: string) {
    await pushSubscriptionsDAO.upsert(makePushSub(deviceId));
    await deviceUsersDAO.upsert(deviceId, TEST_USER);
}

describe('Reactive push subscription cleanup', () => {
    it('deletes subscription when sendNotification returns 410 Gone', async () => {
        await seedSubscribedDevice('dev-gone');
        mockSendNotification.mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));

        await notifyViaWebPush(TEST_USER, null, [makeOp()], dayjs().toISOString());
        // Give fire-and-forget cleanup a moment
        await new Promise<void>((r) => setTimeout(r, 5));

        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-gone' })).toBe(0);
    });

    it('deletes subscription when sendNotification returns 404 Not Found', async () => {
        await seedSubscribedDevice('dev-404');
        mockSendNotification.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { statusCode: 404 }));

        await notifyViaWebPush(TEST_USER, null, [makeOp()], dayjs().toISOString());
        await new Promise<void>((r) => setTimeout(r, 5));

        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-404' })).toBe(0);
    });

    it('does NOT delete subscription for other errors (e.g. 500)', async () => {
        await seedSubscribedDevice('dev-500');
        mockSendNotification.mockRejectedValueOnce(Object.assign(new Error('Internal'), { statusCode: 500 }));

        await notifyViaWebPush(TEST_USER, null, [makeOp()], dayjs().toISOString());
        await new Promise<void>((r) => setTimeout(r, 5));

        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-500' })).toBe(1);
    });

    it('also removes deviceUsers join rows when subscription is gone (410)', async () => {
        // Two accounts share this device — both join rows must be cleared so neither account's
        // future fan-out targets the dead endpoint again.
        await pushSubscriptionsDAO.upsert(makePushSub('dev-shared'));
        await deviceUsersDAO.upsert('dev-shared', TEST_USER);
        await deviceUsersDAO.upsert('dev-shared', 'other-user');
        mockSendNotification.mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));

        await notifyViaWebPush(TEST_USER, null, [makeOp()], dayjs().toISOString());
        await new Promise<void>((r) => setTimeout(r, 5));

        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-shared' })).toBe(0);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-shared' })).toBe(0);
    });
});
