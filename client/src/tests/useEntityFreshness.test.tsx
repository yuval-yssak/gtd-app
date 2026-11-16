// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { IDBPDatabase } from 'idb';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetEntityFreshnessCacheForTests, type OwnedEntityRef, useEntityFreshness } from '../hooks/useEntityFreshness';
import { _resetSyncFreshnessForTests, markVerifiedWithNetwork, notifySyncQueueChanged } from '../lib/syncFreshness';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const ITEM: StoredItem = {
    _id: 'item-1',
    userId: 'user-A',
    status: 'inbox',
    title: 'Call the plumber',
    createdTs: '2026-11-16T10:00:00.000Z',
    updatedTs: '2026-11-16T10:00:00.000Z',
};

const ITEM_REF: OwnedEntityRef = { entityType: 'item', entityId: ITEM._id, userId: ITEM.userId };

function FreshnessLabel({ db, entity }: { db: IDBPDatabase<MyDB>; entity: OwnedEntityRef }) {
    return <p>freshness: {useEntityFreshness(db, entity)}</p>;
}

/** Mounts the label for `entity` (the item by default) and returns a live count of fallback renders. */
async function mountLabel(entity: OwnedEntityRef = ITEM_REF) {
    const fallbackRenders = { count: 0 };
    const Fallback = () => {
        fallbackRenders.count += 1;
        return <p>loading</p>;
    };
    await act(async () => {
        render(
            <Suspense fallback={<Fallback />}>
                <FreshnessLabel db={db} entity={entity} />
            </Suspense>,
        );
    });
    return fallbackRenders;
}

async function queueChangeToItem() {
    const opId = await db.add('syncOperations', {
        userId: ITEM.userId,
        entityType: 'item',
        entityId: ITEM._id,
        opType: 'update',
        queuedAt: '2026-11-16T10:00:00.000Z',
        snapshot: ITEM,
    });
    await act(async () => notifySyncQueueChanged());
    return opId;
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    cleanup();
    _resetSyncFreshnessForTests();
    _resetEntityFreshnessCacheForTests();
    db.close();
});

describe('useEntityFreshness', () => {
    it('is unverified before any pull from the server has landed', async () => {
        await mountLabel();

        expect(await screen.findByText('freshness: unverified')).toBeTruthy();
    });

    it('turns current once the owner account has been checked with the server', async () => {
        await mountLabel();

        await act(async () => markVerifiedWithNetwork(ITEM.userId));

        expect(await screen.findByText('freshness: current')).toBeTruthy();
    });

    it('is unsynced while a change to the item waits in the queue, and current once the push drained it', async () => {
        markVerifiedWithNetwork(ITEM.userId);
        await mountLabel();

        const opId = await queueChangeToItem();
        expect(await screen.findByText('freshness: unsynced')).toBeTruthy();

        await db.delete('syncOperations', opId);
        await act(async () => notifySyncQueueChanged());
        expect(await screen.findByText('freshness: current')).toBeTruthy();
    });

    it('keeps showing the last answer while it re-reads the queue — the badge never blinks out', async () => {
        markVerifiedWithNetwork(ITEM.userId);
        const fallbackRenders = await mountLabel();
        await screen.findByText('freshness: current');
        const fallbackRendersBeforeChange = fallbackRenders.count;

        await queueChangeToItem();

        expect(await screen.findByText('freshness: unsynced')).toBeTruthy();
        expect(fallbackRenders.count).toBe(fallbackRendersBeforeChange);
    });

    it('reads the queue for the entity type it is given — a routine page reports its own pending change', async () => {
        markVerifiedWithNetwork('user-A');
        await db.add('syncOperations', {
            userId: 'user-A',
            entityType: 'routine',
            entityId: 'routine-1',
            opType: 'update',
            queuedAt: '2026-11-16T10:00:00.000Z',
            snapshot: null,
        });

        await mountLabel({ entityType: 'routine', entityId: 'routine-1', userId: 'user-A' });

        expect(await screen.findByText('freshness: unsynced')).toBeTruthy();
    });

    // A brief borrows its item's id: a queued brief change is not a change to the item.
    it("does not mark the item unsynced for a queued change to the item's brief", async () => {
        markVerifiedWithNetwork(ITEM.userId);
        await db.add('syncOperations', {
            userId: ITEM.userId,
            entityType: 'itemBrief',
            entityId: ITEM._id,
            opType: 'update',
            queuedAt: '2026-11-16T10:00:00.000Z',
            snapshot: null,
        });

        await mountLabel();

        expect(await screen.findByText('freshness: current')).toBeTruthy();
    });
});
