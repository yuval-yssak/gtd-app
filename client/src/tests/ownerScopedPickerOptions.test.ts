import { describe, expect, it } from 'vitest';
import { scopeOptionsToOwner } from '../lib/ownerScopedPickerOptions';

interface FakeContext {
    _id: string;
    userId: string;
    name: string;
}

const personalAnywhere: FakeContext = { _id: 'ctx-personal-anywhere', userId: 'user-personal', name: 'anywhere' };
const personalPhone: FakeContext = { _id: 'ctx-personal-phone', userId: 'user-personal', name: 'near a phone' };
const workAnywhere: FakeContext = { _id: 'ctx-work-anywhere', userId: 'user-work', name: 'anywhere' };
const allContexts = [personalAnywhere, personalPhone, workAnywhere];

describe('scopeOptionsToOwner', () => {
    it('keeps only the owner account options, killing the duplicate "anywhere"', () => {
        const scoped = scopeOptionsToOwner(allContexts, { ownerUserId: 'user-personal', assignedIds: [], allOptions: allContexts });
        expect(scoped).toEqual([personalAnywhere, personalPhone]);
    });

    it('appends an already-assigned cross-account option so its chip still renders', () => {
        const scoped = scopeOptionsToOwner(allContexts, { ownerUserId: 'user-personal', assignedIds: [workAnywhere._id], allOptions: allContexts });
        expect(scoped).toEqual([personalAnywhere, personalPhone, workAnywhere]);
    });

    it('does not duplicate an assigned option the owner already has', () => {
        const scoped = scopeOptionsToOwner(allContexts, { ownerUserId: 'user-personal', assignedIds: [personalAnywhere._id], allOptions: allContexts });
        expect(scoped).toEqual([personalAnywhere, personalPhone]);
    });

    it('resolves assigned strays from the unfiltered set even when the pool omits them', () => {
        // Callers on list pages pass visibility-filtered pools; a hidden account's assigned tag
        // must still resolve through allOptions.
        const visibilityFilteredPool = [personalAnywhere, personalPhone];
        const scoped = scopeOptionsToOwner(visibilityFilteredPool, { ownerUserId: 'user-personal', assignedIds: [workAnywhere._id], allOptions: allContexts });
        expect(scoped).toEqual([personalAnywhere, personalPhone, workAnywhere]);
    });

    it('silently drops assigned ids that resolve nowhere (deleted entity)', () => {
        const scoped = scopeOptionsToOwner(allContexts, { ownerUserId: 'user-personal', assignedIds: ['ctx-deleted'], allOptions: allContexts });
        expect(scoped).toEqual([personalAnywhere, personalPhone]);
    });

    it('dedupes repeated assigned ids', () => {
        const scoped = scopeOptionsToOwner(allContexts, {
            ownerUserId: 'user-personal',
            assignedIds: [workAnywhere._id, workAnywhere._id],
            allOptions: allContexts,
        });
        expect(scoped).toEqual([personalAnywhere, personalPhone, workAnywhere]);
    });

    it('switches the option set when the owner changes (reassign picker)', () => {
        const scoped = scopeOptionsToOwner(allContexts, { ownerUserId: 'user-work', assignedIds: [], allOptions: allContexts });
        expect(scoped).toEqual([workAnywhere]);
    });
});
