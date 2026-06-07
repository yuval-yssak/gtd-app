/** Boot migration: legacy `items.clarify` scope → `items.write` (loaders/apiTokenScopeMigration.ts).
 *
 * Tokens minted before the Phase 2 scope extension carry `items.clarify` for what is now
 * `items.write`. The in-memory backfill bridge that used to paper over this at auth time has been
 * removed; this boot migration persists the rewrite so the stored scope set matches what auth
 * enforces. These tests seed raw legacy-shaped rows (the scope literal no longer exists in the
 * `ApiTokenScope` union, so they're inserted directly into the collection) and assert convergence,
 * idempotency, and de-duplication. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyClarifyScope } from '../loaders/apiTokenScopeMigration.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('apiTokens').deleteMany({});
});

// Raw insert helper — `scopes` is typed as string[] so it can carry the retired literal that no
// longer narrows to `ApiTokenScope`.
async function insertTokenRow(id: string, scopes: string[]) {
    await db
        .collection('apiTokens')
        .insertOne({ _id: id, user: 'u1', tokenHash: `h-${id}`, label: id, createdTs: '2024-01-01T00:00:00.000Z', scopes } as never);
}

async function readScopes(id: string) {
    const row = await db.collection('apiTokens').findOne({ _id: id } as never);
    return (row as { scopes: string[] } | null)?.scopes;
}

describe('migrateLegacyClarifyScope', () => {
    it('rewrites items.clarify to items.write, preserving the other scopes', async () => {
        await insertTokenRow('legacy', ['items.capture', 'items.read', 'items.clarify']);

        await migrateLegacyClarifyScope(db);

        const scopes = await readScopes('legacy');
        expect(scopes).toContain('items.write');
        expect(scopes).not.toContain('items.clarify');
        expect(scopes).toContain('items.capture');
        expect(scopes).toContain('items.read');
    });

    it('de-duplicates a row that already carries both items.clarify and items.write', async () => {
        await insertTokenRow('mixed', ['items.capture', 'items.clarify', 'items.write']);

        await migrateLegacyClarifyScope(db);

        const scopes = await readScopes('mixed');
        expect(scopes).not.toContain('items.clarify');
        // items.write appears exactly once — $addToSet is a no-op when it already exists.
        expect(scopes?.filter((s) => s === 'items.write')).toHaveLength(1);
    });

    it('leaves a modern row holding items.write untouched', async () => {
        await insertTokenRow('modern', ['items.capture', 'items.read', 'items.write']);

        await migrateLegacyClarifyScope(db);

        expect(await readScopes('modern')).toEqual(['items.capture', 'items.read', 'items.write']);
    });

    it('is idempotent — a second run is a no-op', async () => {
        await insertTokenRow('legacy', ['items.read', 'items.clarify']);

        await migrateLegacyClarifyScope(db);
        const afterFirst = await readScopes('legacy');
        await migrateLegacyClarifyScope(db);
        const afterSecond = await readScopes('legacy');

        expect(afterSecond).toEqual(afterFirst);
        expect(afterSecond).not.toContain('items.clarify');
        expect(afterSecond).toContain('items.write');
    });

    it('migrates many legacy rows in one pass and leaves non-legacy rows alone', async () => {
        await insertTokenRow('legacy-1', ['items.clarify']);
        await insertTokenRow('legacy-2', ['items.read', 'items.clarify']);
        await insertTokenRow('modern', ['items.write']);

        await migrateLegacyClarifyScope(db);

        expect(await readScopes('legacy-1')).toEqual(['items.write']);
        expect(await readScopes('legacy-2')).toContain('items.write');
        expect(await readScopes('legacy-2')).not.toContain('items.clarify');
        expect(await readScopes('modern')).toEqual(['items.write']);
    });
});
