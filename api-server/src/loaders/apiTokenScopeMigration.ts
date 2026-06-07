import type { Db } from 'mongodb';

/**
 * Pre-migration shape: a token row whose `scopes` array still carries the legacy `items.clarify`
 * literal. Declared locally so the migration can read a scope value that no longer exists in the
 * `ApiTokenScope` union — by design, the only place `'items.clarify'` is still named is here.
 */
interface LegacyApiTokenDoc {
    _id: string;
    scopes: string[];
}

/**
 * Rewrites the legacy `items.clarify` scope to its modern equivalent `items.write` on stored token
 * rows. Tokens minted before the Phase 2 scope extension carry `items.clarify`; the bearer
 * middleware used to backfill `items.write` in-memory at auth time. That bridge is gone — this
 * one-time migration persists the rewrite so the stored scope set matches what auth enforces.
 *
 * Idempotent — re-running is a no-op (the `{ scopes: 'items.clarify' }` element-equality filter
 * only matches rows that still carry the legacy literal, and `$addToSet`/`$pull` converge on the
 * same final array).
 *
 * Safe to remove the in-memory backfill bridge that this replaces: the server only begins serving
 * traffic after `loadDataAccess()` (which awaits this migration) resolves, so no request can hit
 * the auth path with an unmigrated `items.clarify` row in this process. The migration fails closed
 * — a throw here aborts boot rather than silently leaving rows unmigrated.
 *
 * Per-token rewrite: `items.clarify` → `items.write`, de-duplicated. A row that already holds both
 * (e.g. a hand-edited row) loses the duplicate; a row holding only `items.clarify` ends up with
 * `items.write` in its place. Order within the array is not preserved for migrated rows — scope
 * checks are membership tests, so ordering is irrelevant.
 */
export async function migrateLegacyClarifyScope(db: Db): Promise<void> {
    const coll = db.collection<LegacyApiTokenDoc>('apiTokens');

    const legacyCount = await coll.countDocuments({ scopes: 'items.clarify' });
    if (!legacyCount) {
        return;
    }

    console.log(`[migrate] apiTokens: rewriting items.clarify → items.write on ${legacyCount} legacy token row(s)`);

    // Two-step so the same row can hold both scopes transiently without violating array semantics:
    // first guarantee items.write is present, then drop the legacy literal. $addToSet is a no-op
    // when items.write already exists, keeping the merge de-duplicated.
    await coll.updateMany({ scopes: 'items.clarify' }, { $addToSet: { scopes: 'items.write' } });
    await coll.updateMany({ scopes: 'items.clarify' }, { $pull: { scopes: 'items.clarify' } });
}
