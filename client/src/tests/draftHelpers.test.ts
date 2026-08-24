import { describe, expect, it } from 'vitest';
import { wipeUserData } from '../db/accountHelpers';
import {
    deleteInboxCaptureDraft,
    deleteQuickCaptureDraft,
    getInboxCaptureDraft,
    getQuickCaptureDraft,
    saveInboxCaptureDraft,
    saveQuickCaptureDraft,
} from '../db/draftHelpers';
import { openTestDB } from './openTestDB';

const USER = 'user-1';

describe('draftHelpers (inbox capture)', () => {
    it('round-trips a draft per user', async () => {
        const db = await openTestDB();
        await saveInboxCaptureDraft(db, USER, { title: 'Call the plumber', notes: 'about the **leak**' });

        const draft = await getInboxCaptureDraft(db, USER);
        expect(draft?.title).toBe('Call the plumber');
        expect(draft?.notes).toBe('about the **leak**');
        expect(draft?.userId).toBe(USER);

        // Another user's draft slot is independent.
        expect(await getInboxCaptureDraft(db, 'user-2')).toBeUndefined();
    });

    it('saving an all-whitespace draft deletes the row instead of persisting blanks', async () => {
        const db = await openTestDB();
        await saveInboxCaptureDraft(db, USER, { title: 'something', notes: '' });
        await saveInboxCaptureDraft(db, USER, { title: '  ', notes: '\n' });
        expect(await getInboxCaptureDraft(db, USER)).toBeUndefined();
    });

    it('saving again overwrites the existing draft in place', async () => {
        const db = await openTestDB();
        await saveInboxCaptureDraft(db, USER, { title: 'first', notes: 'a' });
        await saveInboxCaptureDraft(db, USER, { title: 'second', notes: '' });

        const draft = await getInboxCaptureDraft(db, USER);
        expect(draft?.title).toBe('second');
        expect(draft?.notes).toBe('');
        expect(await db.count('drafts')).toBe(1);
    });

    it('delete clears the draft (commit path)', async () => {
        const db = await openTestDB();
        await saveInboxCaptureDraft(db, USER, { title: 'x', notes: '' });
        await deleteInboxCaptureDraft(db, USER);
        expect(await getInboxCaptureDraft(db, USER)).toBeUndefined();
    });

    it("wipeUserData removes only the signed-out user's drafts", async () => {
        const db = await openTestDB();
        await saveInboxCaptureDraft(db, USER, { title: 'mine', notes: '' });
        await saveInboxCaptureDraft(db, 'user-2', { title: 'theirs', notes: '' });

        await wipeUserData(USER, db);

        expect(await getInboxCaptureDraft(db, USER)).toBeUndefined();
        expect((await getInboxCaptureDraft(db, 'user-2'))?.title).toBe('theirs');
    });
});

describe('draftHelpers (quick capture)', () => {
    it('round-trips independently of the inbox capture draft under the same user', async () => {
        const db = await openTestDB();
        await saveQuickCaptureDraft(db, USER, { title: 'half a thought', notes: '- with **md** notes' });

        const draft = await getQuickCaptureDraft(db, USER);
        expect(draft).toMatchObject({ kind: 'quickCapture', title: 'half a thought', notes: '- with **md** notes', userId: USER });
        // Separate kinds/keys: the inbox page's field must not restore the FAB's leftover.
        expect(await getInboxCaptureDraft(db, USER)).toBeUndefined();

        await deleteQuickCaptureDraft(db, USER);
        expect(await getQuickCaptureDraft(db, USER)).toBeUndefined();
    });

    it('an all-whitespace draft deletes the row instead of persisting blanks', async () => {
        const db = await openTestDB();
        await saveQuickCaptureDraft(db, USER, { title: 'text', notes: '' });
        await saveQuickCaptureDraft(db, USER, { title: '  ', notes: '' });
        expect(await getQuickCaptureDraft(db, USER)).toBeUndefined();
    });
});
