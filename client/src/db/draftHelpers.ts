import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredInboxCaptureDraft } from '../types/MyDB';

/**
 * Device-local draft persistence. Drafts hold text the user typed but has not committed as an
 * entity write yet (e.g. the inbox capture field), so an accidental reload or navigation never
 * loses in-progress input. Drafts are never synced — commit clears them and writes the real entity.
 */

export function inboxCaptureDraftKey(userId: string): string {
    return `inboxCapture:${userId}`;
}

export async function getInboxCaptureDraft(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredInboxCaptureDraft | undefined> {
    const draft = await db.get('drafts', inboxCaptureDraftKey(userId));
    return draft?.kind === 'inboxCapture' ? draft : undefined;
}

/** Writes the draft when it has content; a fully-empty draft deletes the row instead so the store
 *  never accumulates blank leftovers after the user clears the field manually. */
export async function saveInboxCaptureDraft(db: IDBPDatabase<MyDB>, userId: string, fields: { title: string; notes: string }): Promise<void> {
    if (!fields.title.trim() && !fields.notes.trim()) {
        await deleteInboxCaptureDraft(db, userId);
        return;
    }
    await db.put('drafts', {
        key: inboxCaptureDraftKey(userId),
        kind: 'inboxCapture',
        userId,
        title: fields.title,
        notes: fields.notes,
        updatedTs: dayjs().toISOString(),
    });
}

export async function deleteInboxCaptureDraft(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    await db.delete('drafts', inboxCaptureDraftKey(userId));
}
