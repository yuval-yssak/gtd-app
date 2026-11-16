// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { IDBPDatabase } from 'idb';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetItemFreshnessCacheForTests, useItemFreshness } from '../hooks/useItemFreshness';
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

function FreshnessLabel({ db }: { db: IDBPDatabase<MyDB> }) {
    return <p>freshness: {useItemFreshness(db, ITEM)}</p>;
}

/** Mounts the label and returns a live count of fallback renders. */
async function mountLabel() {
    const fallbackRenders = { count: 0 };
    const Fallback = () => {
        fallbackRenders.count += 1;
        return <p>loading</p>;
    };
    await act(async () => {
        render(
            <Suspense fallback={<Fallback />}>
                <FreshnessLabel db={db} />
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
    _resetItemFreshnessCacheForTests();
    db.close();
});

describe('useItemFreshness', () => {
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
});
