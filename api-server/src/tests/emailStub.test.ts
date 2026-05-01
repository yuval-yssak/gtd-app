/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts queried docs are present */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sentEmailsDAO from '../dataAccess/sentEmailsDAO.js';
import { sendEmail } from '../lib/emailStub.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test_email_stub');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('sentEmails').deleteMany({});
    vi.restoreAllMocks();
});

describe('sendEmail', () => {
    it('inserts a row with all fields populated and ISO sentAt', async () => {
        await sendEmail({
            userId: 'user-1',
            to: 'alice@example.com',
            subject: 'Action required',
            body: 'reconnect plz',
            kind: 'calendar_auth_warning',
        });

        const rows = await sentEmailsDAO.findArray({});
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row._id).toBeTruthy();
        expect(row.userId).toBe('user-1');
        expect(row.to).toBe('alice@example.com');
        expect(row.subject).toBe('Action required');
        expect(row.body).toBe('reconnect plz');
        expect(row.kind).toBe('calendar_auth_warning');
        // Match a basic ISO 8601 datetime — guards against accidentally writing a millisecond timestamp.
        expect(row.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('logs `[email-stub]` with kind, recipient, and subject', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await sendEmail({
            userId: 'user-2',
            to: 'bob@example.com',
            subject: 'Disconnected',
            body: '...',
            kind: 'calendar_auth_revoked',
        });

        const stubLogs = logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[email-stub]'));
        expect(stubLogs).toHaveLength(1);
        expect(stubLogs[0]).toContain('kind=calendar_auth_revoked');
        expect(stubLogs[0]).toContain('to=bob@example.com');
        expect(stubLogs[0]).toContain('subject="Disconnected"');
    });
});
