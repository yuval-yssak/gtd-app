/** Webhook delivery worker behaviour (issue #19 step 8): retry, abandon, auto-disable, signature shape. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import webhookDeliveriesDAO from '../dataAccess/webhookDeliveriesDAO.js';
import webhookSubscriptionsDAO from '../dataAccess/webhookSubscriptionsDAO.js';
import {
    enqueueWebhookDeliveries,
    MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE,
    MAX_DELIVERY_ATTEMPTS,
    mapOpToEvents,
    runWorkerTick,
    signDeliveryBody,
} from '../lib/webhookDeliveryWorker.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';

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

const SAMPLE_ITEM: ItemInterface = {
    _id: 'item-1',
    user: 'u1',
    status: 'inbox',
    title: 'webhook test',
    createdTs: '2026-05-06T12:00:00.000Z',
    updatedTs: '2026-05-06T12:00:00.000Z',
};

const SAMPLE_OP: OperationInterface = {
    _id: 'op-1',
    user: 'u1',
    entityType: 'item',
    entityId: 'item-1',
    opType: 'create',
    snapshot: SAMPLE_ITEM,
    deviceId: 'api:tok-1',
    ts: '2026-05-06T12:00:00.000Z',
};

async function seedSubscription(overrides: Partial<{ url: string; events: ('item.created' | 'item.completed')[]; user: string; secret: string }> = {}) {
    const sub = {
        _id: 'sub-1',
        user: overrides.user ?? 'u1',
        url: overrides.url ?? 'https://hooks.example/in',
        events: overrides.events ?? (['item.created'] as ('item.created' | 'item.completed')[]),
        secret: overrides.secret ?? 'test-secret',
        createdTs: '2026-05-01T00:00:00.000Z',
    };
    await webhookSubscriptionsDAO.insertOne(sub);
    return sub;
}

describe('signDeliveryBody', () => {
    it('produces sha256=<hex> with HMAC-SHA256 of the request body', () => {
        const body = '{"hello":"world"}';
        const sig = signDeliveryBody('shh', body);
        const expected = `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}`;
        expect(sig).toBe(expected);
    });
});

describe('mapOpToEvents', () => {
    it('maps inbox-create ops to item.created', () => {
        expect(mapOpToEvents(SAMPLE_OP)).toEqual(['item.created']);
    });

    it('maps update-to-done to item.completed', () => {
        expect(mapOpToEvents({ ...SAMPLE_OP, opType: 'update', snapshot: { ...SAMPLE_ITEM, status: 'done' } })).toEqual(['item.completed']);
    });

    it('returns no events for irrelevant ops (e.g. nextAction creation)', () => {
        expect(mapOpToEvents({ ...SAMPLE_OP, snapshot: { ...SAMPLE_ITEM, status: 'nextAction' } })).toEqual([]);
    });

    it('returns no events for non-item entities', () => {
        expect(mapOpToEvents({ ...SAMPLE_OP, entityType: 'person' })).toEqual([]);
    });
});

describe('enqueueWebhookDeliveries', () => {
    it('enqueues one row per matching active subscription', async () => {
        await seedSubscription({ events: ['item.created'] });
        await webhookSubscriptionsDAO.insertOne({
            _id: 'sub-2',
            user: 'u1',
            url: 'https://hooks.example/another',
            events: ['item.completed'],
            secret: 's2',
            createdTs: '2026-05-01T00:00:00.000Z',
        });
        await enqueueWebhookDeliveries(SAMPLE_OP);
        const queued = await webhookDeliveriesDAO.findArray({});
        expect(queued).toHaveLength(1);
        expect(queued[0]!.subscriptionId).toBe('sub-1');
    });

    it('skips disabled subscriptions', async () => {
        await webhookSubscriptionsDAO.insertOne({
            _id: 'sub-1',
            user: 'u1',
            url: 'https://hooks.example/disabled',
            events: ['item.created'],
            secret: 's',
            createdTs: '2026-05-01T00:00:00.000Z',
            disabledTs: '2026-05-02T00:00:00.000Z',
            disabledReason: 'consecutive_failures',
        });
        await enqueueWebhookDeliveries(SAMPLE_OP);
        const queued = await webhookDeliveriesDAO.findArray({});
        expect(queued).toEqual([]);
    });

    it('no-ops when no subscriptions match', async () => {
        await enqueueWebhookDeliveries(SAMPLE_OP);
        expect(await webhookDeliveriesDAO.findArray({})).toEqual([]);
    });
});

describe('runWorkerTick', () => {
    it('on 2xx: marks delivered, sets lastDeliveredTs, resets failureCount', async () => {
        await seedSubscription();
        await enqueueWebhookDeliveries(SAMPLE_OP);
        // Pre-set a failureCount to confirm it gets cleared.
        await webhookSubscriptionsDAO.recordFailure('sub-1', 99, '2026-05-05T00:00:00.000Z');

        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
        const handled = await runWorkerTick({ fetchImpl, now: () => new Date('2026-05-06T12:00:01.000Z') });
        expect(handled).toBe(1);

        const sub = await webhookSubscriptionsDAO.findOne({ _id: 'sub-1' });
        expect(sub?.lastDeliveredTs).toBe('2026-05-06T12:00:01.000Z');
        expect(sub?.failureCount).toBe(0);

        const delivery = (await webhookDeliveriesDAO.findArray({}))[0]!;
        expect(delivery.deliveredTs).toBe('2026-05-06T12:00:01.000Z');
    });

    it('signs the request body with HMAC-SHA256 and includes the headers', async () => {
        await seedSubscription({ secret: 'shh' });
        await enqueueWebhookDeliveries(SAMPLE_OP);
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
        await runWorkerTick({ fetchImpl, now: () => new Date('2026-05-06T12:00:01.000Z') });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [_url, init] = fetchImpl.mock.calls[0]!;
        const body = init.body as string;
        const sentSig = (init.headers as Record<string, string>)['X-GTD-Signature'];
        expect(sentSig).toBe(signDeliveryBody('shh', body));
        expect((init.headers as Record<string, string>)['X-GTD-Event']).toBe('item.created');
        expect((init.headers as Record<string, string>)['X-GTD-Delivery-Id']).toBeTruthy();
    });

    it('on non-2xx: schedules retry with backoff; abandons after MAX_DELIVERY_ATTEMPTS', async () => {
        await seedSubscription();
        await enqueueWebhookDeliveries(SAMPLE_OP);
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

        // Simulate worker ticks at increasing times, each time advancing past the previous retry's delay.
        const baseTime = new Date('2026-05-06T12:00:00.000Z');
        for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
            const now = new Date(baseTime.getTime() + attempt * 60 * 60 * 1000); // +1h per attempt — well beyond any retry delay
            await runWorkerTick({ fetchImpl, now: () => now });
        }

        const delivery = (await webhookDeliveriesDAO.findArray({}))[0]!;
        expect(delivery.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
        expect(delivery.abandonedTs).toBeTruthy();
        expect(delivery.deliveredTs).toBeUndefined();
    });

    it('after MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE abandoned deliveries, the subscription auto-disables', async () => {
        await seedSubscription();
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
        const baseTime = new Date('2026-05-06T12:00:00.000Z');
        // Fire enough deliveries that each runs through MAX_DELIVERY_ATTEMPTS and abandons.
        for (let i = 0; i < MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE; i++) {
            await enqueueWebhookDeliveries({ ...SAMPLE_OP, _id: `op-${i}`, entityId: `item-${i}` });
        }
        // Run enough ticks for each delivery's attempts to all complete. CLAIMS_PER_TICK is 10
        // so all 7 are picked up at once; we run MAX_DELIVERY_ATTEMPTS ticks to exhaust each.
        for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
            const now = new Date(baseTime.getTime() + attempt * 60 * 60 * 1000);
            await runWorkerTick({ fetchImpl, now: () => now });
        }
        const sub = await webhookSubscriptionsDAO.findOne({ _id: 'sub-1' });
        expect(sub?.disabledTs).toBeTruthy();
        expect(sub?.disabledReason).toBe('consecutive_failures');
    });

    it('drops orphan deliveries when the subscription was deleted', async () => {
        await seedSubscription();
        await enqueueWebhookDeliveries(SAMPLE_OP);
        await webhookSubscriptionsDAO.deleteByOwner('sub-1', 'u1');
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
        await runWorkerTick({ fetchImpl, now: () => new Date('2026-05-06T12:00:01.000Z') });
        // Fetch was never called (no subscription to deliver to).
        expect(fetchImpl).toHaveBeenCalledTimes(0);
        const delivery = (await webhookDeliveriesDAO.findArray({}))[0]!;
        expect(delivery.deliveredTs).toBeTruthy();
    });
});
