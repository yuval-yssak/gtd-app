import itemsDAO from '../dataAccess/itemsDAO.js';
import { isValidRank, topRank } from './itemRank.js';

/**
 * The user's lowest existing rank (code-unit order), or null when none is ranked yet. `$type:
 * 'string'` rather than `$exists` so the non-sparse `{ user, rank }` index serves it in one key —
 * done/trash rows stay unranked forever and `$exists: true` would walk every one of them first.
 * `sort: { rank: 1 }` is a binary sort in Mongo, exactly the order these keys are compared in.
 * A malformed stored key (schema-rejected today, but a row may predate the refine) makes this fall
 * back to the ORIGIN key: the mint can then collide with an existing `a0`, which the client's
 * run re-key resolves on the next drag — acceptable, where a throw would break every mint for the
 * owner.
 */
export async function lowestRankForUser(userId: string): Promise<string | null> {
    const lowest = await itemsDAO.findOne({ user: userId, rank: { $type: 'string' } }, { sort: { rank: 1 }, projection: { rank: 1 } });
    if (lowest?.rank === undefined) {
        return null;
    }
    if (!isValidRank(lowest.rank)) {
        console.warn(`[rank] ignoring malformed stored rank ${JSON.stringify(lowest.rank)} on item ${lowest._id} (user ${userId})`);
        return null;
    }
    return lowest.rank;
}

/**
 * The rank a new item of this user should be minted with: strictly below the user's lowest
 * existing key (`topRank`), so it lands at the top of whatever date section it belongs to.
 * Mirrors `topRankForUser` in `client/src/db/itemHelpers.ts`.
 */
export async function topRankForUser(userId: string): Promise<string> {
    return topRank(await lowestRankForUser(userId));
}
