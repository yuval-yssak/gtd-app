import type { ItemInterface } from '../types/entities.js';

/**
 * `rank` is universal and server-minted on several creation paths, and other devices' drags write
 * it too, so a client snapshot WITHOUT a rank is one the device has not pulled the rank into yet —
 * never an intentional clear ("absent" always means "not minted yet", see `ItemInterface.rank`).
 * Carried status-independently, unlike the calendar link. Mirrors `RANK_CARRIED_FIELDS` in
 * `client/src/db/rankMerge.ts` (parity-pinned in both test files); change both together.
 */
export const RANK_CARRIED_FIELDS = ['rank'] as const;

/**
 * Keeps the stored row's `rank` on an incoming item snapshot that lacks one. Pure; the apply
 * pipeline runs it through `hydrateItemCarryForwards` so the row, the op log and every device see
 * the merged snapshot. Without it the whole-document `replaceById` apply would erase a rank the
 * moment any device edited the row before pulling it (after the backfill, after another device's
 * drag).
 */
export function carryForwardRank(existing: ItemInterface, incoming: ItemInterface): ItemInterface {
    if (incoming.rank !== undefined || existing.rank === undefined) {
        return incoming;
    }
    return { ...incoming, rank: existing.rank };
}
