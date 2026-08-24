import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredCaptureDraft } from '../types/MyDB';

/**
 * Device-local draft persistence. Drafts hold text the user typed but has not committed as an
 * entity write yet (e.g. the inbox capture field, the quick-capture dialog), so an accidental
 * reload or navigation never loses in-progress input. Drafts are never synced — commit clears
 * them and writes the real entity.
 */

type CaptureDraftKind = StoredCaptureDraft<'inboxCapture' | 'quickCapture'>['kind'];

function captureDraftKey(kind: CaptureDraftKind, userId: string): string {
    return `${kind}:${userId}`;
}

async function getCaptureDraft<Kind extends CaptureDraftKind>(
    db: IDBPDatabase<MyDB>,
    kind: Kind,
    userId: string,
): Promise<StoredCaptureDraft<Kind> | undefined> {
    const draft = await db.get('drafts', captureDraftKey(kind, userId));
    return draft?.kind === kind ? (draft as StoredCaptureDraft<Kind>) : undefined;
}

/** Writes the draft when it has content; a fully-empty draft deletes the row instead so the store
 *  never accumulates blank leftovers after the user clears the field manually. */
async function saveCaptureDraft(db: IDBPDatabase<MyDB>, kind: CaptureDraftKind, userId: string, fields: { title: string; notes: string }): Promise<void> {
    if (!fields.title.trim() && !fields.notes.trim()) {
        await deleteCaptureDraft(db, kind, userId);
        return;
    }
    await db.put('drafts', {
        key: captureDraftKey(kind, userId),
        kind,
        userId,
        title: fields.title,
        notes: fields.notes,
        updatedTs: dayjs().toISOString(),
    });
}

async function deleteCaptureDraft(db: IDBPDatabase<MyDB>, kind: CaptureDraftKind, userId: string): Promise<void> {
    await db.delete('drafts', captureDraftKey(kind, userId));
}

// ── Inbox page capture field ─────────────────────────────────────────────────

export function inboxCaptureDraftKey(userId: string): string {
    return captureDraftKey('inboxCapture', userId);
}

export const getInboxCaptureDraft = (db: IDBPDatabase<MyDB>, userId: string) => getCaptureDraft(db, 'inboxCapture', userId);

export const saveInboxCaptureDraft = (db: IDBPDatabase<MyDB>, userId: string, fields: { title: string; notes: string }) =>
    saveCaptureDraft(db, 'inboxCapture', userId, fields);

export const deleteInboxCaptureDraft = (db: IDBPDatabase<MyDB>, userId: string) => deleteCaptureDraft(db, 'inboxCapture', userId);

// ── Global quick-capture dialog ──────────────────────────────────────────────

export const getQuickCaptureDraft = (db: IDBPDatabase<MyDB>, userId: string) => getCaptureDraft(db, 'quickCapture', userId);

export const saveQuickCaptureDraft = (db: IDBPDatabase<MyDB>, userId: string, fields: { title: string; notes: string }) =>
    saveCaptureDraft(db, 'quickCapture', userId, fields);

export const deleteQuickCaptureDraft = (db: IDBPDatabase<MyDB>, userId: string) => deleteCaptureDraft(db, 'quickCapture', userId);
