import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { briefSourceHash } from '../lib/briefSource';
import type { MyDB, StoredItem, StoredItemBrief } from '../types/MyDB';
import { deleteItemBriefById, getItemBriefById, putItemBrief } from './itemBriefHelpers';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

/**
 * Upserts a user-authored brief for `item`. The `sourceHash` is stamped from the item's CURRENT
 * title/notes so the brief reads as `fresh` until the text moves on (then `pinnedStale`). One
 * row per item (`_id === item._id`): a second call from any device converges via LWW on
 * `updatedTs` rather than duplicating. Blank text is a clear (returns null): a stored brief
 * always has visible text, so the review never leads with an empty line.
 */
export async function setUserBrief(db: IDBPDatabase<MyDB>, item: StoredItem, text: string): Promise<StoredItemBrief | null> {
    const trimmedText = text.trim();
    if (!trimmedText) {
        await clearBrief(db, item._id);
        return null;
    }
    const existing = await getItemBriefById(db, item._id);
    const brief = buildUserBrief(item, trimmedText, existing);
    await putItemBrief(db, brief);
    await queueSyncOp(db, { opType: existing ? 'update' : 'create', entityType: 'itemBrief', entityId: brief._id, snapshot: brief, userId: brief.userId });
    return brief;
}

function buildUserBrief(item: StoredItem, trimmedText: string, existing: StoredItemBrief | undefined): StoredItemBrief {
    const now = nowIso();
    return {
        _id: item._id,
        itemId: item._id,
        userId: item.userId,
        text: trimmedText,
        origin: 'user',
        sourceHash: briefSourceHash(item.title, item.notes),
        generatedTs: now,
        createdTs: existing?.createdTs ?? now,
        updatedTs: now,
    };
}

/** Removes the brief for `itemId` (no-op when none exists) and queues the delete op. */
export async function clearBrief(db: IDBPDatabase<MyDB>, itemId: string): Promise<void> {
    // Read the owning userId before delete so the queued delete op is scoped to the right account.
    const existing = await getItemBriefById(db, itemId);
    if (!existing) {
        return;
    }
    await deleteItemBriefById(db, itemId);
    await queueSyncOp(db, { opType: 'delete', entityType: 'itemBrief', entityId: itemId, snapshot: null, userId: existing.userId });
}
