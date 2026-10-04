import dayjs from 'dayjs';
import type { Document } from 'mongodb';
import { db } from '../loaders/mainLoader.js';
import { applyExportPolicy, USER_DATA_COLLECTIONS, USER_ROW_SPEC, type UserIdentity } from './userDataInventory.js';
import { findUserById } from './userLookup.js';

/**
 * Builds the "Download my data" payload: every collection in `userDataInventory.ts`, with
 * credentials stripped per its export policy, plus an `omitted` map naming what was left out and
 * why. Built from the same inventory that account deletion uses, so the export shows exactly the
 * set of rows a deletion would erase.
 */

export const EXPORT_FORMAT = 'done-export/1';

export interface UserDataExport {
    format: typeof EXPORT_FORMAT;
    exportedAt: string;
    user: Document | null;
    collections: Record<string, Document[]>;
    omitted: Record<string, { reason: string; count: number }>;
}

export function exportFilename(now = dayjs()): string {
    return `done-export-${now.format('YYYY-MM-DD')}.json`;
}

export async function exportUserData(userId: string): Promise<UserDataExport> {
    const user = await findUserById(userId);
    const owner: UserIdentity = { userId, email: user?.email?.toLowerCase() ?? null };
    const sections = await Promise.all(USER_DATA_COLLECTIONS.map((spec) => exportCollection(spec, owner)));
    return {
        format: EXPORT_FORMAT,
        exportedAt: dayjs().toISOString(),
        user: user ? (applyExportPolicy(USER_ROW_SPEC, [{ ...user, _id: String(user._id) }])?.[0] ?? null) : null,
        collections: Object.fromEntries(sections.flatMap((section) => (section.docs ? [[section.collection, section.docs] as const] : []))),
        omitted: Object.fromEntries(sections.flatMap((section) => (section.omitted ? [[section.collection, section.omitted] as const] : []))),
    };
}

interface ExportedSection {
    collection: string;
    docs: Document[] | null;
    omitted: { reason: string; count: number } | null;
}

async function exportCollection(spec: (typeof USER_DATA_COLLECTIONS)[number], owner: UserIdentity): Promise<ExportedSection> {
    const filter = spec.filter(owner);
    if (spec.export.kind === 'omitted') {
        const count = await db.collection(spec.collection).countDocuments(filter);
        return { collection: spec.collection, docs: null, omitted: { reason: spec.export.reason, count } };
    }
    const docs = await db.collection(spec.collection).find(filter).toArray();
    return { collection: spec.collection, docs: applyExportPolicy(spec, docs), omitted: null };
}
