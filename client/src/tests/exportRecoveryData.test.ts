import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import dayjs from 'dayjs';
import { buildLocalSnapshotExportFile, buildPendingOpsExportFile, downloadRecoveryExports, RAW_JSON_SEPARATOR } from '../db/exportRecoveryData';
import type { MyDB, StoredItem, SyncOperation } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

function makeItem(id: string, userId: string, title: string): StoredItem {
    return { _id: id, userId, status: 'inbox', title, createdTs: '2025-01-01T00:00:00.000Z', updatedTs: '2025-01-01T00:00:00.000Z' };
}

function makeQueuedOp(entityId: string, userId: string, title: string): SyncOperation {
    return {
        userId,
        opType: 'create',
        entityType: 'item',
        entityId,
        queuedAt: dayjs().toISOString(),
        snapshot: makeItem(entityId, userId, title),
    };
}

/** Splits an export on the separator and parses the JSON tail — the machine-readability contract. */
function parseExport(content: string): { summary: string; payload: unknown } {
    const [summary, rawJson] = content.split(RAW_JSON_SEPARATOR);
    if (summary === undefined || rawJson === undefined) {
        throw new Error('expected exactly one RAW JSON separator');
    }
    return { summary, payload: JSON.parse(rawJson) };
}

beforeEach(async () => {
    db = await openTestDB();
    await db.put('items', makeItem('item-a1', 'user-a', 'Mine'));
    await db.put('items', makeItem('item-b1', 'user-b', 'Not mine'));
    await db.put('people', { _id: 'person-a1', userId: 'user-a', name: 'Alice', createdTs: '2025-01-01T00:00:00.000Z', updatedTs: '2025-01-01T00:00:00.000Z' });
    await db.add('syncOperations', makeQueuedOp('op-1', 'user-a', 'Buy milk'));
    await db.add('syncOperations', { ...makeQueuedOp('op-2', 'user-a', 'Old draft'), opType: 'delete', snapshot: null });
    // A person op exercises describeQueuedOp's `name` branch (people have no `title`).
    await db.add('syncOperations', {
        userId: 'user-a',
        opType: 'create',
        entityType: 'person',
        entityId: 'op-3',
        queuedAt: dayjs().toISOString(),
        snapshot: { _id: 'person-a2', userId: 'user-a', name: 'Bob', createdTs: '2025-01-01T00:00:00.000Z', updatedTs: '2025-01-01T00:00:00.000Z' },
    });
    await db.add('syncOperations', makeQueuedOp('op-b', 'user-b', 'Other user'));
});

afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
});

describe('buildPendingOpsExportFile', () => {
    it("contains a human-readable summary and a parseable JSON tail scoped to the user's queue", async () => {
        const file = await buildPendingOpsExportFile(db, 'user-a');

        expect(file.filename).toBe(`gtd-pending-changes-user-a-${dayjs().format('YYYY-MM-DD')}.txt`);
        const { summary, payload } = parseExport(file.content);
        expect(summary).toContain('Total pending operations: 3');
        expect(summary).toContain('By operation type: create=2 delete=1');
        expect(summary).toContain('By entity type: item=2 person=1');
        expect(summary).toContain('- create item: "Buy milk"');
        // People have no `title` — described by their `name`.
        expect(summary).toContain('- create person: "Bob"');
        // Delete ops carry no snapshot — described by entity id instead of a title.
        expect(summary).toContain('- delete item op-2');
        // The other user's queued op must not leak into this export.
        expect(summary).not.toContain('Other user');

        const ops = payload as SyncOperation[];
        expect(ops).toHaveLength(3);
        expect(ops.map((op) => op.entityId)).toEqual(['op-1', 'op-2', 'op-3']);
    });
});

describe('buildLocalSnapshotExportFile', () => {
    it("contains per-store counts and a parseable JSON snapshot of the user's entity stores", async () => {
        const file = await buildLocalSnapshotExportFile(db, 'user-a');

        expect(file.filename).toBe(`gtd-local-snapshot-user-a-${dayjs().format('YYYY-MM-DD')}.txt`);
        const { summary, payload } = parseExport(file.content);
        expect(summary).toContain('items: 1');
        expect(summary).toContain('people: 1');
        expect(summary).toContain('routines: 0');
        expect(summary).toContain('workContexts: 0');

        const snapshot = payload as { items: StoredItem[]; routines: unknown[]; people: unknown[]; workContexts: unknown[] };
        expect(snapshot.items.map((item) => item._id)).toEqual(['item-a1']);
        expect(snapshot.people).toHaveLength(1);
        // user-b's item is excluded from user-a's snapshot.
        expect(snapshot.items.some((item) => item.userId === 'user-b')).toBe(false);
    });
});

describe('downloadRecoveryExports', () => {
    it('triggers exactly two downloads — pending queue + local snapshot — via object URLs', async () => {
        const clickedDownloads: string[] = [];
        const anchorFactory = () => {
            const anchor = { href: '', download: '', click: vi.fn() };
            anchor.click.mockImplementation(() => clickedDownloads.push(anchor.download));
            return anchor;
        };
        vi.stubGlobal('document', { createElement: vi.fn(anchorFactory) });
        const createObjectURL = vi.fn(() => 'blob:fake-url');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

        await downloadRecoveryExports(db, 'user-a');

        expect(clickedDownloads).toEqual([
            `gtd-pending-changes-user-a-${dayjs().format('YYYY-MM-DD')}.txt`,
            `gtd-local-snapshot-user-a-${dayjs().format('YYYY-MM-DD')}.txt`,
        ]);
        // Every created object URL is revoked — no blob leaks.
        expect(createObjectURL).toHaveBeenCalledTimes(2);
        expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    });
});
