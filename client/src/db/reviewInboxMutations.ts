import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredReviewInbox } from '../types/MyDB';
import { deleteReviewInboxById, getReviewInboxesByUser, putReviewInbox } from './reviewInboxHelpers';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

export type NewReviewInboxFields = Omit<StoredReviewInbox, '_id' | 'createdTs' | 'updatedTs'>;

export async function createReviewInbox(db: IDBPDatabase<MyDB>, fields: NewReviewInboxFields & { _id?: string }): Promise<StoredReviewInbox> {
    const now = nowIso();
    const { _id, ...rest } = fields;
    const reviewInbox: StoredReviewInbox = { ...rest, _id: _id ?? crypto.randomUUID(), createdTs: now, updatedTs: now };
    await putReviewInbox(db, reviewInbox);
    await queueSyncOp(db, { opType: 'create', entityType: 'reviewInbox', entityId: reviewInbox._id, snapshot: reviewInbox, userId: reviewInbox.userId });
    return reviewInbox;
}

export async function updateReviewInbox(db: IDBPDatabase<MyDB>, reviewInbox: StoredReviewInbox): Promise<StoredReviewInbox> {
    const updated: StoredReviewInbox = { ...reviewInbox, updatedTs: nowIso() };
    await putReviewInbox(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'reviewInbox', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

export async function removeReviewInbox(db: IDBPDatabase<MyDB>, reviewInboxId: string): Promise<void> {
    // Read the owning userId before delete so the queued delete op is scoped to the right account.
    const existing = await db.get('reviewInboxes', reviewInboxId);
    await deleteReviewInboxById(db, reviewInboxId);
    await queueSyncOp(db, {
        opType: 'delete',
        entityType: 'reviewInbox',
        entityId: reviewInboxId,
        snapshot: null,
        ...(existing?.userId ? { userId: existing.userId } : {}),
    });
}

/** Persists a new checklist ordering: every row whose position moved gets an update op. */
export async function reorderReviewInboxes(db: IDBPDatabase<MyDB>, orderedInboxes: StoredReviewInbox[]): Promise<StoredReviewInbox[]> {
    return Promise.all(orderedInboxes.map(async (inbox, index) => (inbox.order === index ? inbox : updateReviewInbox(db, { ...inbox, order: index }))));
}

export const DEFAULT_REVIEW_INBOX_NAMES = ['Email', 'Physical In Tray', 'Voice recordings'] as const;

const seededMarkerKey = (userId: string) => `gtd:reviewInboxes:seeded:${userId}`;

function hasSeededMarker(userId: string): boolean {
    try {
        return localStorage.getItem(seededMarkerKey(userId)) !== null;
    } catch {
        return false;
    }
}

function setSeededMarker(userId: string): void {
    try {
        localStorage.setItem(seededMarkerKey(userId), dayjs().toISOString());
    } catch {
        // Storage unavailable — the local-emptiness check below remains the only (weaker) guard.
    }
}

/**
 * Seeds the starter capture buckets on first use of the weekly review. Deterministic per-user ids
 * (`<userId>:default-<index>`) make a concurrent seed from a second device converge on the same
 * rows via LWW instead of duplicating them.
 *
 * Two guards keep the seed from clobbering server truth, because the emptiness check reads LOCAL
 * IDB only: (1) a device-local seeded marker (survives sign-out wipes on purpose) so a user who
 * deleted the defaults never has them resurrected by this device; (2) callers must additionally
 * hold off until the first sync has landed (`isInitialSyncing === false`) — seeding into the
 * pre-first-pull empty window would stamp `updatedTs = now` over the server's rows for the same
 * deterministic ids, and LWW would then revert renames made on another device.
 */
export async function seedDefaultReviewInboxesIfEmpty(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredReviewInbox[]> {
    const existing = await getReviewInboxesByUser(db, userId);
    if (existing.length > 0) {
        setSeededMarker(userId);
        return existing;
    }
    if (hasSeededMarker(userId)) {
        return existing;
    }
    const seeded = await Promise.all(
        DEFAULT_REVIEW_INBOX_NAMES.map((name, index) => createReviewInbox(db, { _id: `${userId}:default-${index}`, userId, name, order: index })),
    );
    setSeededMarker(userId);
    return seeded;
}
