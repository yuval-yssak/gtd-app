import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, SyncOperation } from '../types/MyDB';
import { describeQueuedOp, readQueuedOpsForUser } from './syncRecovery';

/**
 * Case-2 recovery "Export": two separate text files — the pending syncOperations queue, and a full
 * local IndexedDB snapshot of the user's entity stores. Each file is a short human-readable summary
 * followed by a `--- RAW JSON ---` separator and pretty-printed JSON, so it can be both eyeballed
 * and machine-parsed (split on the separator, JSON.parse the tail).
 */

export const RAW_JSON_SEPARATOR = '--- RAW JSON ---';

export interface RecoveryExportFile {
    filename: string;
    content: string;
}

function buildExportContent(summaryLines: string[], payload: unknown): string {
    return `${summaryLines.join('\n')}\n\n${RAW_JSON_SEPARATOR}\n${JSON.stringify(payload, null, 2)}\n`;
}

function countBy<T>(rows: T[], keyOf: (row: T) => string): string {
    const counts = rows.reduce<Map<string, number>>((acc, row) => acc.set(keyOf(row), (acc.get(keyOf(row)) ?? 0) + 1), new Map());
    return [...counts.entries()].map(([key, count]) => `${key}=${count}`).join(' ') || 'none';
}

function pendingOpsSummary(userId: string, ops: SyncOperation[]): string[] {
    return [
        'GTD pending offline changes export',
        `User: ${userId}`,
        `Exported: ${dayjs().toISOString()}`,
        `Total pending operations: ${ops.length}`,
        `By operation type: ${countBy(ops, (op) => op.opType)}`,
        `By entity type: ${countBy(ops, (op) => op.entityType)}`,
        'Pending changes:',
        ...ops.map((op) => `- ${describeQueuedOp(op)}`),
    ];
}

export async function buildPendingOpsExportFile(db: IDBPDatabase<MyDB>, userId: string): Promise<RecoveryExportFile> {
    const ops = await readQueuedOpsForUser(db, userId);
    return {
        filename: `gtd-pending-changes-${userId}-${dayjs().format('YYYY-MM-DD')}.txt`,
        content: buildExportContent(pendingOpsSummary(userId, ops), ops),
    };
}

export async function buildLocalSnapshotExportFile(db: IDBPDatabase<MyDB>, userId: string): Promise<RecoveryExportFile> {
    // All entity stores index by userId, so the snapshot is scoped to the recovering account.
    const [items, routines, people, workContexts, reviewInboxes] = await Promise.all([
        db.getAllFromIndex('items', 'userId', userId),
        db.getAllFromIndex('routines', 'userId', userId),
        db.getAllFromIndex('people', 'userId', userId),
        db.getAllFromIndex('workContexts', 'userId', userId),
        db.getAllFromIndex('reviewInboxes', 'userId', userId),
    ]);
    const summaryLines = [
        'GTD local data snapshot export',
        `User: ${userId}`,
        `Exported: ${dayjs().toISOString()}`,
        `items: ${items.length}`,
        `routines: ${routines.length}`,
        `people: ${people.length}`,
        `workContexts: ${workContexts.length}`,
        `reviewInboxes: ${reviewInboxes.length}`,
    ];
    return {
        filename: `gtd-local-snapshot-${userId}-${dayjs().format('YYYY-MM-DD')}.txt`,
        content: buildExportContent(summaryLines, { items, routines, people, workContexts, reviewInboxes }),
    };
}

function downloadTextFile({ filename, content }: RecoveryExportFile): void {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

/** Triggers both downloads. Does NOT resolve the recovery dialog — export is a side action, not a choice. */
export async function downloadRecoveryExports(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    downloadTextFile(await buildPendingOpsExportFile(db, userId));
    downloadTextFile(await buildLocalSnapshotExportFile(db, userId));
}
