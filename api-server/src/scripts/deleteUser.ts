/**
 * Admin CLI: permanently delete a user and everything they own, leaving a `deletedUsers` tombstone
 * so every device — even one offline for a year — evaporates the account on its next boot.
 * Thin wrapper over `lib/deleteUserCompletely.ts`, which `DELETE /auth/me` also uses. Two steps of
 * that library are in-process and therefore inert from this separate process: the wait for in-flight
 * calendar syncs (the server's lock table is not visible here — the final sweep covers late rows) and
 * the SSE `account-deleted` broadcast (the server's open streams are not reachable — live tabs learn of
 * the deletion when their next request 401s and the tombstone probe answers `deleted`).
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/deleteUser.ts (--email <addr> | --user-id <id>) [--dry-run] [--yes]
 *
 *   --dry-run   Print the per-collection counts that WOULD be deleted; change nothing (no Google calls).
 *   --yes       Skip the interactive "type the email to confirm" prompt.
 */

import { createInterface } from 'node:readline/promises';
import deletedUsersDAO from '../dataAccess/deletedUsersDAO.js';
import { type DeletionReport, deleteUserCompletely } from '../lib/deleteUserCompletely.js';
import { findUserIdByEmail, getUserEmail } from '../lib/userLookup.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';

export interface DeleteUserCliOptions {
    email?: string;
    userId?: string;
    dryRun: boolean;
    yes: boolean;
}

/** Pure, so the flag handling is unit-testable without a database. */
export function parseDeleteUserArgs(argv: string[]): DeleteUserCliOptions {
    const argValue = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        if (index < 0) {
            return undefined;
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Flag ${flag} requires a value`);
        }
        return value;
    };
    const email = argValue('--email');
    const userId = argValue('--user-id');
    if (!email && !userId) {
        throw new Error('Pass --email <addr> or --user-id <id>');
    }
    if (email && userId) {
        throw new Error('Pass either --email or --user-id, not both');
    }
    return {
        ...(email !== undefined ? { email } : {}),
        ...(userId !== undefined ? { userId } : {}),
        dryRun: argv.includes('--dry-run'),
        yes: argv.includes('--yes'),
    };
}

/** Confirmation stands between a typo'd email and an irreversible deletion; --yes is for scripted runs. */
export function confirmationMatches(typed: string, email: string | null): boolean {
    return email !== null && typed.trim().toLowerCase() === email.toLowerCase();
}

/**
 * Resolves the account to delete. `--user-id` is accepted for a live user AND for an id that already
 * carries a tombstone (a re-run after a crash is idempotent); an id with neither is a typo, and
 * refusing it keeps `--yes` from minting a tombstone for an account that never existed.
 */
export async function resolveTarget(options: DeleteUserCliOptions): Promise<{ userId: string; email: string | null }> {
    if (options.email) {
        const userId = await findUserIdByEmail(options.email);
        if (!userId) {
            throw new Error(`No user found with email ${options.email}`);
        }
        return { userId, email: options.email.toLowerCase() };
    }
    const userId = options.userId ?? '';
    const email = await getUserEmail(userId);
    if (email === null && !(await deletedUsersDAO.findByUserId(userId))) {
        throw new Error(`No user (or deletion record) found for id ${userId}`);
    }
    return { userId, email };
}

async function promptForConfirmation(email: string | null): Promise<boolean> {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const typed = await readline.question(`Type the email (${email ?? 'unknown — user row missing'}) to confirm permanent deletion: `);
        return confirmationMatches(typed, email);
    } finally {
        readline.close();
    }
}

function printReport(report: DeletionReport): void {
    console.log(report.dryRun ? '\nDRY RUN — nothing was changed. Would delete:' : '\nDeleted:');
    for (const [collection, count] of Object.entries(report.deleted)) {
        console.log(`  ${collection.padEnd(24)} ${count}`);
    }
    console.log(
        `Webhook channels: ${report.webhookChannels.attempted} live, ${report.webhookChannels.succeeded} stopped, ${report.webhookChannels.skipped} skipped, ${report.webhookChannels.failed} failed`,
    );
    console.log(
        `Google token revocations: ${report.googleTokenRevocations.attempted} attempted, ${report.googleTokenRevocations.succeeded} ok, ${report.googleTokenRevocations.skipped} skipped (grant shared with another account, or no readable token), ${report.googleTokenRevocations.failed} failed`,
    );
    console.log(`Tombstone written: ${report.tombstoneWritten}  SSE connections closed: ${report.sseConnectionsClosed}`);
}

async function run(): Promise<void> {
    const options = parseDeleteUserArgs(process.argv.slice(2));
    await loadDataAccess();
    try {
        const target = await resolveTarget(options);
        console.log(`Target user ${target.userId} (${target.email ?? 'no user row'})`);
        if (!options.dryRun && !options.yes && !(await promptForConfirmation(target.email))) {
            console.log('Confirmation did not match — aborting.');
            process.exitCode = 1;
            return;
        }
        printReport(await deleteUserCompletely(target.userId, { dryRun: options.dryRun }));
    } finally {
        await closeDataAccess();
    }
}

// Only run when executed directly — the test suite imports the pure helpers above.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    run().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
