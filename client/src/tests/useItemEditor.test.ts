import { describe, expect, it } from 'vitest';
import { resolveVariant } from '../components/itemEditor/useItemEditor';
import type { StoredItem } from '../types/MyDB';

const ITEM: StoredItem = {
    _id: 'item-1',
    userId: 'user-A',
    status: 'inbox',
    title: 'Test item',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

const ANCHOR = {} as HTMLElement;

// resolveVariant centralises every fall-through rule the editor mode picker has to honour:
// instant only fires for nextAction on inbox; expand/popover collapse to dialog on mobile;
// popover without an anchor collapses to dialog. Lock the rules in here so a refactor that
// inadvertently relaxes them gets caught without rendering the editor.
describe('resolveVariant', () => {
    describe('dialog mode', () => {
        it('resolves to dialog state regardless of anchor or mobile', () => {
            const out = resolveVariant('dialog', { item: ITEM }, false, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: undefined } });
        });

        it('preserves initialStatus when provided', () => {
            const out = resolveVariant('dialog', { item: ITEM, initialStatus: 'nextAction' }, false, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: 'nextAction' } });
        });
    });

    describe('expand mode', () => {
        it('resolves to expand state on desktop', () => {
            const out = resolveVariant('expand', { item: ITEM }, false, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'expand', item: ITEM, initialStatus: undefined } });
        });

        it('falls back to dialog on mobile', () => {
            const out = resolveVariant('expand', { item: ITEM }, true, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: undefined } });
        });
    });

    describe('popover mode', () => {
        it('resolves to popover state when anchor provided on desktop', () => {
            const out = resolveVariant('popover', { item: ITEM, anchor: ANCHOR }, false, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'popover', item: ITEM, initialStatus: undefined, anchor: ANCHOR } });
        });

        it('falls back to dialog when no anchor', () => {
            const out = resolveVariant('popover', { item: ITEM }, false, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: undefined } });
        });

        it('falls back to dialog on mobile even with anchor', () => {
            const out = resolveVariant('popover', { item: ITEM, anchor: ANCHOR }, true, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: undefined } });
        });
    });

    describe('instant mode', () => {
        it('fires instant when allowed AND initialStatus is nextAction', () => {
            const out = resolveVariant('instant', { item: ITEM, initialStatus: 'nextAction' }, false, true);
            expect(out).toEqual({ kind: 'instant', item: ITEM });
        });

        it('falls back to dialog when not allowed (non-inbox host)', () => {
            const out = resolveVariant('instant', { item: ITEM, initialStatus: 'nextAction' }, false, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: 'nextAction' } });
        });

        it('falls back to dialog for calendar destination (needs date)', () => {
            const out = resolveVariant('instant', { item: ITEM, initialStatus: 'calendar' }, false, true);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: 'calendar' } });
        });

        it('falls back to dialog for waitingFor destination (needs person)', () => {
            const out = resolveVariant('instant', { item: ITEM, initialStatus: 'waitingFor' }, false, true);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: 'waitingFor' } });
        });

        it('falls back to dialog when no initialStatus given (e.g. row body click)', () => {
            const out = resolveVariant('instant', { item: ITEM }, false, true);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', item: ITEM, initialStatus: undefined } });
        });
    });

    describe('page mode', () => {
        it('returns the page sentinel — no state, caller navigates', () => {
            const out = resolveVariant('page', { item: ITEM }, false, false);
            expect(out).toEqual({ kind: 'page' });
        });

        it('still routes to page on mobile', () => {
            const out = resolveVariant('page', { item: ITEM }, true, false);
            expect(out).toEqual({ kind: 'page' });
        });
    });

    // Locks in the contract that load-bears the wrapper's React `key` composition: opening
    // the same item again with a different `initialStatus` MUST produce a different state so
    // the host's `key={item._id + initialStatus}` forces a remount and re-seeds the body's
    // local status. Without this, a chip click on an already-open expand row silently no-ops.
    describe('initialStatus differentiation', () => {
        it('produces distinct states for different initialStatus on the same item', () => {
            const out1 = resolveVariant('dialog', { item: ITEM, initialStatus: 'nextAction' }, false, false);
            const out2 = resolveVariant('dialog', { item: ITEM, initialStatus: 'calendar' }, false, false);
            expect(out1).not.toEqual(out2);
        });
    });
});
