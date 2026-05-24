/** Reference cascades: when a person or workContext is deleted, every item that referenced them
 * gets the ref stripped + a `[person|context removed: <name>]` breadcrumb appended to its title.
 * Cascades run via the pipeline so MCP / batch / REST / direct sync all converge on identical
 * behaviour. Tests pin: ref-strip, breadcrumb format, scalar `waitingForPersonId` handling, double-
 * tag when both ref kinds match, idempotency, op emission, archived-item coverage. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts result before using ! */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations } from '../lib/applyOperation.js';
import * as calendarPushback from '../lib/calendarPushback.js';
import { cascadePersonReferenceRemoval, cascadeWorkContextReferenceRemoval } from '../lib/referenceCascades.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, PersonInterface, WorkContextInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('items').deleteMany({}),
        db.collection('people').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
        db.collection('operations').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

const userId = 'user-cascade-test';
const ts = '2026-05-08T10:00:00Z';

function itemOf(overrides: Partial<ItemInterface>): ItemInterface {
    return { _id: 'item-x', user: userId, status: 'nextAction', title: 'do thing', createdTs: ts, updatedTs: ts, ...overrides };
}

describe('cascadePersonReferenceRemoval', () => {
    it('strips personId from peopleIds and appends a [person removed] breadcrumb', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'call Jane', peopleIds: ['p-jane', 'p-bob'] }));

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.peopleIds).toEqual(['p-bob']);
        expect(after!.title).toBe('call Jane [person removed: Jane Doe]');
    });

    it('removes the peopleIds field entirely when the last ref is pulled', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', peopleIds: ['p-jane'] }));

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane');

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.peopleIds).toBeUndefined();
    });

    it('unsets waitingForPersonId and appends the [was waiting for] breadcrumb', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', status: 'waitingFor', title: 'get NDA back', waitingForPersonId: 'p-jane' }));

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.waitingForPersonId).toBeUndefined();
        expect(after!.title).toBe('get NDA back [was waiting for: Jane Doe]');
    });

    it('emits both breadcrumb tags when an item carries the personId in both shapes', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', status: 'waitingFor', title: 'Jane stuff', peopleIds: ['p-jane'], waitingForPersonId: 'p-jane' }));

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.peopleIds).toBeUndefined();
        expect(after!.waitingForPersonId).toBeUndefined();
        expect(after!.title).toBe('Jane stuff [person removed: Jane Doe] [was waiting for: Jane Doe]');
    });

    it('is idempotent — re-running with the same name does not double-append', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'call Jane', peopleIds: ['p-jane'] }));
        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');
        // Second run finds no items by id (ref already pulled) → no-op.
        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');
        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.title).toBe('call Jane [person removed: Jane Doe]');
    });

    it('cascades to done and trash items, not only active ones', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-done', status: 'done', title: 'done thing', peopleIds: ['p-jane'] }));
        await itemsDAO.insertOne(itemOf({ _id: 'i-trash', status: 'trash', title: 'trashed thing', peopleIds: ['p-jane'] }));

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');

        const done = await itemsDAO.findByOwnerAndId('i-done', userId);
        const trash = await itemsDAO.findByOwnerAndId('i-trash', userId);
        expect(done!.title).toContain('[person removed: Jane Doe]');
        expect(trash!.title).toContain('[person removed: Jane Doe]');
    });

    it('emits one operation row per affected item', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', peopleIds: ['p-jane'] }));
        await itemsDAO.insertOne(itemOf({ _id: 'i-2', peopleIds: ['p-jane'] }));

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane');

        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', opType: 'update' });
        expect(ops).toHaveLength(2);
        expect(ops.map((o) => o.entityId).sort()).toEqual(['i-1', 'i-2']);
    });

    it('no-ops when no items reference the deleted person', async () => {
        await cascadePersonReferenceRemoval(userId, 'p-no-refs', 'Nobody');
        const ops = await operationsDAO.findArray({ user: userId });
        expect(ops).toHaveLength(0);
    });
});

describe('cascadeWorkContextReferenceRemoval', () => {
    it('strips contextId and appends [context removed]', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'vacuum', workContextIds: ['wc-home', 'wc-cleaning'] }));

        await cascadeWorkContextReferenceRemoval(userId, 'wc-home', 'home');

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.workContextIds).toEqual(['wc-cleaning']);
        expect(after!.title).toBe('vacuum [context removed: home]');
    });

    it('removes workContextIds entirely when the last ref is pulled', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', workContextIds: ['wc-home'] }));
        await cascadeWorkContextReferenceRemoval(userId, 'wc-home', 'home');
        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.workContextIds).toBeUndefined();
    });

    it('is idempotent — repeated runs do not double-append', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'vacuum', workContextIds: ['wc-home'] }));
        await cascadeWorkContextReferenceRemoval(userId, 'wc-home', 'home');
        await cascadeWorkContextReferenceRemoval(userId, 'wc-home', 'home');
        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.title).toBe('vacuum [context removed: home]');
    });
});

describe('pipeline integration — delete via applyAndPublishOperation', () => {
    it('person delete via the pipeline triggers the cascade end-to-end', async () => {
        const person: PersonInterface = { _id: 'p-jane', user: userId, name: 'Jane Doe', createdTs: ts, updatedTs: ts };
        await peopleDAO.insertOne(person);
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'call Jane', peopleIds: ['p-jane'] }));

        await applyAndPublishOperation(userId, { entityType: 'person', opType: 'delete', entityId: 'p-jane', snapshot: null }, { deviceId: 'api:tok-1' });

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.peopleIds).toBeUndefined();
        expect(after!.title).toBe('call Jane [person removed: Jane Doe]');
        // Three operations total: the person delete + one item update.
        const ops = await operationsDAO.findArray({ user: userId });
        expect(ops).toHaveLength(2);
    });

    it('workContext delete via the pipeline triggers the cascade end-to-end', async () => {
        const wc: WorkContextInterface = { _id: 'wc-home', user: userId, name: 'home', createdTs: ts, updatedTs: ts };
        await workContextsDAO.insertOne(wc);
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'vacuum', workContextIds: ['wc-home'] }));

        await applyAndPublishOperation(userId, { entityType: 'workContext', opType: 'delete', entityId: 'wc-home', snapshot: null }, { deviceId: 'api:tok-1' });

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.workContextIds).toBeUndefined();
        expect(after!.title).toBe('vacuum [context removed: home]');
    });

    it('batch delete of two people fires the cascade for each via the batch pipeline', async () => {
        await peopleDAO.insertOne({ _id: 'p-jane', user: userId, name: 'Jane', createdTs: ts, updatedTs: ts });
        await peopleDAO.insertOne({ _id: 'p-bob', user: userId, name: 'Bob', createdTs: ts, updatedTs: ts });
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'call Jane', peopleIds: ['p-jane'] }));
        await itemsDAO.insertOne(itemOf({ _id: 'i-2', title: 'call Bob', peopleIds: ['p-bob'] }));

        await applyAndPublishOperations(
            userId,
            [
                { entityType: 'person', opType: 'delete', entityId: 'p-jane', snapshot: null },
                { entityType: 'person', opType: 'delete', entityId: 'p-bob', snapshot: null },
            ],
            { deviceId: 'api:tok-1' },
        );

        const i1 = await itemsDAO.findByOwnerAndId('i-1', userId);
        const i2 = await itemsDAO.findByOwnerAndId('i-2', userId);
        expect(i1!.title).toBe('call Jane [person removed: Jane]');
        expect(i2!.title).toBe('call Bob [person removed: Bob]');
    });

    it('cascade-emitted item update does NOT itself trigger another cascade pass', async () => {
        await peopleDAO.insertOne({ _id: 'p-jane', user: userId, name: 'Jane Doe', createdTs: ts, updatedTs: ts });
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', peopleIds: ['p-jane'] }));

        await applyAndPublishOperation(userId, { entityType: 'person', opType: 'delete', entityId: 'p-jane', snapshot: null }, { deviceId: 'api:tok-1' });

        // Exactly two ops total: the person delete + ONE item update. If item updates recursed
        // into cascades, we'd see additional ops per cascade pass.
        const ops = await operationsDAO.findArray({ user: userId });
        expect(ops).toHaveLength(2);
        const updateOps = ops.filter((o) => o.entityType === 'item' && o.opType === 'update');
        expect(updateOps).toHaveLength(1);
    });
});

describe('cascade does not echo breadcrumbs to GCal', () => {
    // The breadcrumb tag is a GTD-side artifact for our own lists. Pushing it into a Google
    // Calendar event title would clutter other attendees' calendars. The cascade must call the
    // pipeline with `suppressGCalPushback: true` so `maybePushToGCal` never sees the cascade-
    // emitted update op.
    it('suppresses GCal pushback when the affected item is calendar-linked', async () => {
        const pushSpy = vi.spyOn(calendarPushback, 'maybePushToGCal').mockResolvedValue(undefined);
        await itemsDAO.insertOne(
            itemOf({
                _id: 'i-cal-1',
                status: 'calendar',
                title: 'Lunch with Jane',
                peopleIds: ['p-jane'],
                timeStart: '2026-05-20T12:00:00Z',
                timeEnd: '2026-05-20T13:00:00Z',
                calendarEventId: 'gcal-evt-1',
                calendarIntegrationId: 'integ-1',
                calendarSyncConfigId: 'config-1',
            }),
        );

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');

        // The fan-out for the cascade-emitted item update should not have hit maybePushToGCal.
        await new Promise((r) => setTimeout(r, 30));
        expect(pushSpy).not.toHaveBeenCalled();
        // ...but the item itself should still have the breadcrumb applied locally.
        const after = await itemsDAO.findByOwnerAndId('i-cal-1', userId);
        expect(after!.title).toBe('Lunch with Jane [person removed: Jane Doe]');
    });
});

describe('cascade vs concurrent edits', () => {
    // The pre-fix cascade did `findAll → mutate snapshot → replace via LWW pipeline`, which
    // clobbered ALL unrelated edits landing between the find and the apply. The fixed version
    // uses atomic `$pull` + `$set(title, updatedTs)`, so a concurrent edit on fields the cascade
    // does NOT touch (e.g. notes) survives. Concurrent title edits are still clobbered — the
    // cascade composes the new title from a stale read; that's an acknowledged trade-off.
    it('preserves a concurrent edit on fields the cascade does not touch (notes)', async () => {
        await itemsDAO.insertOne(itemOf({ _id: 'i-1', title: 'call Jane', notes: 'original notes', peopleIds: ['p-jane'] }));

        // Simulate the race by mutating the item between the affected-items find inside the
        // cascade and the per-item updateOne. We patch findArray to issue the concurrent edit
        // before returning.
        const realFind = itemsDAO.findArray.bind(itemsDAO);
        vi.spyOn(itemsDAO, 'findArray').mockImplementationOnce(async (...args) => {
            const result = await realFind(...(args as Parameters<typeof realFind>));
            // Concurrent device update: edits notes.
            await itemsDAO.updateOne({ _id: 'i-1', user: userId } as never, { $set: { notes: 'edited concurrently', updatedTs: '2026-05-09T12:00:00Z' } });
            return result as ItemInterface[];
        });

        await cascadePersonReferenceRemoval(userId, 'p-jane', 'Jane Doe');

        const after = await itemsDAO.findByOwnerAndId('i-1', userId);
        expect(after!.title).toBe('call Jane [person removed: Jane Doe]');
        expect(after!.peopleIds).toBeUndefined();
        // The concurrent notes edit survives — the cascade only touches title + refs.
        expect(after!.notes).toBe('edited concurrently');
    });
});
