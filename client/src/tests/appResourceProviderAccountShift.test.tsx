// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import type { IDBPDatabase } from 'idb';
import { Suspense, use } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppResourceProvider, useAppResource } from '../data/AppResourceProvider';
import { _resetAppResourceCacheForTests, getAppResource } from '../data/appResource';
import { putItem } from '../db/itemHelpers';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_A = 'user-A';
const USER_B = 'user-B';
const FALLBACK = 'fallback';

function inboxItem(userId: string): StoredItem {
    return { _id: `item-${userId}`, userId, status: 'inbox', title: userId, createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' };
}

/** Every rendered frame, in order: the item titles shown, or FALLBACK. */
let shownFrames: string[] = [];

function ItemTitles() {
    const items = use(useAppResource().snapshot.items);
    const titles = items
        .map((item) => item.title)
        .sort()
        .join(',');
    shownFrames.push(titles);
    return <p>{titles}</p>;
}

function Fallback() {
    shownFrames.push(FALLBACK);
    return <p>loading</p>;
}

function tree(db: IDBPDatabase<MyDB>, userIds: string[]) {
    return (
        <AppResourceProvider db={db} userIds={userIds}>
            <Suspense fallback={<Fallback />}>
                <ItemTitles />
            </Suspense>
        </AppResourceProvider>
    );
}

/** Applies `change` inside an awaited act — React only retries a suspended render inside an act scope in tests. */
async function actUntilLoaded(db: IDBPDatabase<MyDB>, userIds: string[], change: () => void) {
    await act(async () => {
        change();
        await getAppResource(db, userIds).items;
    });
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    _resetAppResourceCacheForTests();
    shownFrames = [];
    db = await openTestDB();
    await putItem(db, inboxItem(USER_A));
    await putItem(db, inboxItem(USER_B));
});

afterEach(cleanup);

/** Boots on `userIds` and returns the render result plus how many frames boot took. */
async function bootOn(userIds: string[]) {
    const views: ReturnType<typeof render>[] = [];
    await actUntilLoaded(db, userIds, () => views.push(render(tree(db, userIds))));
    const [view] = views;
    if (!view) throw new Error('expected the tree to render');
    return { view, bootFrameCount: shownFrames.length };
}

describe('AppResourceProvider — the signed-in account set changes', () => {
    it('suspends on the first mount, so boot renders its data in one piece', async () => {
        await bootOn([USER_A]);
        expect(shownFrames[0]).toBe(FALLBACK);
        expect(shownFrames.at(-1)).toBe(USER_A);
    });

    it('keeps showing the current data, never the fallback, until an added account has loaded', async () => {
        const { view, bootFrameCount } = await bootOn([USER_A]);

        // The multi-session seed adds a second account just after boot.
        await actUntilLoaded(db, [USER_A, USER_B], () => view.rerender(tree(db, [USER_A, USER_B])));

        const framesAfterShift = shownFrames.slice(bootFrameCount);
        expect(framesAfterShift).not.toContain(FALLBACK);
        expect(framesAfterShift.at(-1)).toBe(`${USER_A},${USER_B}`);
    });

    it('never shows the fallback when an account goes away, and drops its data once the shift lands', async () => {
        const { view, bootFrameCount } = await bootOn([USER_A, USER_B]);

        // Another account evaporated (deleted elsewhere) — the one removal that does not reload.
        await actUntilLoaded(db, [USER_A], () => view.rerender(tree(db, [USER_A])));

        const framesAfterShift = shownFrames.slice(bootFrameCount);
        expect(framesAfterShift).not.toContain(FALLBACK);
        expect(framesAfterShift.at(-1)).toBe(USER_A);
    });
});
