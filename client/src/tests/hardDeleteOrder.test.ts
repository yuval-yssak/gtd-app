/**
 * Every hard delete of a synced row must go through `queueDeleteThenRemove`: queueing the delete op
 * after removing the row opens a window where a pull finds neither and resurrects the entity (see
 * `queueDeleteThenRemove` in db/syncHelpers.ts). A source scan, because the next hard-delete path is
 * written by someone who has never heard of the race — three of the first ten sites were missed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '..');
// A delete op handed straight to queueSyncOp rather than through the helper. Textual, so it relies
// on the house style of an inline object with `opType` before any nested braces; an op built in a
// variable, or one with a `{…}` spread ahead of `opType`, would slip past it.
const DIRECT_DELETE_QUEUE = /queueSyncOp\(\s*db\s*,\s*\{[^}]*opType:\s*'delete'/g;

function productionSourceFiles(): string[] {
    return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.tsx?$/.test(file) && !/\.(test|stories|mock)\.tsx?$/.test(file) && !file.startsWith('tests'))
        .map((file) => path.join(SRC_DIR, file));
}

function directDeleteQueues(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(DIRECT_DELETE_QUEUE)].map((match) => {
        const line = source.slice(0, match.index).split('\n').length;
        return `${path.relative(SRC_DIR, file)}:${line}`;
    });
}

describe('hard deletes queue their op before removing the row', () => {
    it('no delete op is queued directly with queueSyncOp — use queueDeleteThenRemove', () => {
        expect(productionSourceFiles().flatMap(directDeleteQueues)).toEqual([]);
    });

    it('the scan recognises a direct delete queue (guards the regex itself)', () => {
        const sample = "await db.delete('items', id);\n    await queueSyncOp(db, { opType: 'delete', entityType: 'item', entityId: id, snapshot: null });";
        expect([...sample.matchAll(DIRECT_DELETE_QUEUE)]).toHaveLength(1);
    });
});
