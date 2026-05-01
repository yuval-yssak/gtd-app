import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import sentEmailsDAO from '../dataAccess/sentEmailsDAO.js';

export type EmailKind = 'calendar_auth_warning' | 'calendar_auth_revoked';

export interface SendEmailArgs {
    userId: string;
    to: string;
    subject: string;
    body: string;
    kind: EmailKind;
}

/**
 * Stub email sender. Persists an audit row to `sentEmails` and logs `[email-stub] ...` to stdout.
 * No external email provider is wired up yet — see `api-server/README.md` § Email (stub) for the
 * forward-compatibility contract: replace this body with a real provider call while keeping the
 * signature and audit-log insert so prior sends remain queryable.
 */
export async function sendEmail(args: SendEmailArgs): Promise<void> {
    const sentAt = dayjs().toISOString();
    await sentEmailsDAO.insertOne({
        _id: randomUUID(),
        userId: args.userId,
        to: args.to,
        subject: args.subject,
        body: args.body,
        kind: args.kind,
        sentAt,
    });
    console.log(`[email-stub] kind=${args.kind} to=${args.to} subject=${JSON.stringify(args.subject)}`);
}
