/** The SELECTION rule behind `GET /v1/items?briefState=` — deliberately not the same as the
 * render rule `briefState()`. Pure, so it is unit-tested here rather than through the DB-backed
 * v1 suite (which covers the same matrix end-to-end over seeded rows). */
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { type BriefState, briefSourceHash } from '../lib/briefSource.js';
import { matchesBriefStateFilter } from '../lib/itemBriefs.js';
import type { BriefOrigin, ItemBriefInterface, ItemInterface } from '../types/entities.js';

const TITLE = 'Renew passport';
const NOTES = 'Expires in March; need photos and the old passport before the consulate appointment.';

const item: ItemInterface = {
    _id: 'item-1',
    user: 'user-1',
    status: 'inbox',
    title: TITLE,
    notes: NOTES,
    createdTs: dayjs().toISOString(),
    updatedTs: dayjs().toISOString(),
};

/** A brief row for `item`; `sourceHash` defaults to the item's CURRENT hash (i.e. not stale). */
function brief(origin: BriefOrigin, overrides: Partial<ItemBriefInterface> = {}): ItemBriefInterface {
    const now = dayjs().toISOString();
    return {
        _id: item._id ?? '',
        user: item.user,
        itemId: item._id ?? '',
        text: origin === 'skipped' ? null : 'Passport before the June trip',
        origin,
        sourceHash: briefSourceHash(TITLE, NOTES),
        generatedTs: now,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

/** The one state each row matches, so every case also asserts it matches nothing else. */
function matchedStates(row: ItemBriefInterface | null): BriefState[] {
    const all: BriefState[] = ['none', 'declined', 'fresh', 'pinnedStale'];
    return all.filter((wanted) => matchesBriefStateFilter(item, row, wanted));
}

describe('matchesBriefStateFilter', () => {
    it('selects an item with no brief row under none only', () => {
        expect(matchedStates(null)).toEqual(['none']);
    });

    it('selects a current text-bearing row under fresh only', () => {
        expect(matchedStates(brief('model'))).toEqual(['fresh']);
        expect(matchedStates(brief('user'))).toEqual(['fresh']);
    });

    it('selects a stale authored row under pinnedStale, and a stale model row under none', () => {
        expect(matchedStates(brief('user', { sourceHash: 'stale' }))).toEqual(['pinnedStale']);
        expect(matchedStates(brief('model', { sourceHash: 'stale' }))).toEqual(['none']);
    });

    it('selects a current text-less row under declined — both origins', () => {
        expect(matchedStates(brief('skipped'))).toEqual(['declined']);
        expect(matchedStates(brief('model', { text: null }))).toEqual(['declined']);
    });

    it('excludes a skipped row from none even once its notes moved on (the preserved carve-out)', () => {
        // The row renders as `none` (the decision lapsed), but selecting `none` is how an external
        // sweep finds work — re-offering a row the server already declined would loop forever.
        const staleSkipped = brief('skipped', { sourceHash: 'stale' });
        expect(matchesBriefStateFilter(item, staleSkipped, 'none')).toBe(false);
        expect(matchedStates(staleSkipped)).toEqual([]);
    });

    it('does not extend the carve-out to a stale model row that declined — it is plain none', () => {
        // Only `origin: skipped` is carved out; a model row that moved on is ordinary sweep work.
        expect(matchedStates(brief('model', { text: null, sourceHash: 'stale' }))).toEqual(['none']);
    });
});
