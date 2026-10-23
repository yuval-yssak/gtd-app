import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { lowestRankForUser, topRankForUser } from '../lib/topRankForUser.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('items').deleteMany({});
});

const userId = 'user-top-rank';
const otherUser = 'user-top-rank-other';

function item(id: string, rank: string | undefined, user = userId): ItemInterface {
    return {
        _id: id,
        user,
        status: 'nextAction',
        title: id,
        createdTs: '2026-10-01T00:00:00.000Z',
        updatedTs: '2026-10-01T00:00:00.000Z',
        ...(rank ? { rank } : {}),
    };
}

describe('topRankForUser', () => {
    it('starts at the origin when the user has no ranked item', async () => {
        await itemsDAO.insertOne(item('unranked', undefined));
        expect(await topRankForUser(userId)).toBe('a0');
    });

    it('mints below the lowest existing key', async () => {
        await itemsDAO.insertMany([item('a', 'a0'), item('b', 'a1')]);
        expect(await topRankForUser(userId)).toBe('Zz');
    });

    it('uses binary order: Zz sorts below a0, so the next key goes below Zz', async () => {
        await itemsDAO.insertMany([item('a', 'a0'), item('z', 'Zz')]);
        expect(await topRankForUser(userId)).toBe('Zy');
    });

    it('skips a malformed stored key instead of breaking every later mint', async () => {
        await itemsDAO.insertMany([item('bad', 'A'), item('good', 'a1')]);
        expect(await lowestRankForUser(userId)).toBeNull();
        expect(await topRankForUser(userId)).toBe('a0');
    });

    it('is served by one index key even with many unranked rows ($type, not $exists)', async () => {
        await itemsDAO.insertMany([...Array.from({ length: 200 }, (_, i) => item(`unranked-${i}`, undefined)), item('ranked', 'a0')]);
        const explain = await db
            .collection('items')
            .find({ user: userId, rank: { $type: 'string' } })
            .sort({ rank: 1 })
            .limit(1)
            .explain('executionStats');
        const stats = (explain as { executionStats: { totalKeysExamined: number; totalDocsExamined: number } }).executionStats;
        expect(stats.totalKeysExamined).toBe(1);
        expect(stats.totalDocsExamined).toBe(1);
    });

    it('ignores other users and non-nextAction statuses alike (rank is universal)', async () => {
        await itemsDAO.insertMany([item('o', 'Zz', otherUser), { ...item('done', 'a0'), status: 'done' }]);
        expect(await topRankForUser(userId)).toBe('Zz');
    });
});
