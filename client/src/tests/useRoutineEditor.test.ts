import { describe, expect, it } from 'vitest';
import { resolveRoutineVariant } from '../components/routineEditor/useRoutineEditor';
import type { StoredRoutine } from '../types/MyDB';

const ROUTINE: StoredRoutine = {
    _id: 'r-1',
    userId: 'user-A',
    title: 'Morning standup',
    routineType: 'nextAction',
    rrule: 'FREQ=DAILY',
    template: { energy: 'medium' },
    active: true,
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

const ANCHOR = {} as HTMLElement;

// resolveRoutineVariant centralises the routine editor's mode-fall-through rules. Mirrors
// `resolveVariant` for items but with two routine-specific differences: instant has no analog
// (always falls back to dialog) and creating a new routine always uses dialog regardless of mode.
describe('resolveRoutineVariant', () => {
    describe('dialog mode', () => {
        it('resolves to dialog state for an existing routine', () => {
            const out = resolveRoutineVariant('dialog', { routine: ROUTINE }, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: ROUTINE } });
        });

        it('resolves to dialog state for a new routine (no routine arg)', () => {
            const out = resolveRoutineVariant('dialog', {}, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: undefined } });
        });
    });

    describe('expand mode', () => {
        it('resolves to expand state on desktop with an existing routine', () => {
            const out = resolveRoutineVariant('expand', { routine: ROUTINE }, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'expand', routine: ROUTINE } });
        });

        it('falls back to dialog on mobile', () => {
            const out = resolveRoutineVariant('expand', { routine: ROUTINE }, true);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: ROUTINE } });
        });

        it('falls back to dialog when creating a new routine (no row to anchor to)', () => {
            const out = resolveRoutineVariant('expand', {}, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: undefined } });
        });
    });

    describe('popover mode', () => {
        it('resolves to popover state when anchor provided on desktop', () => {
            const out = resolveRoutineVariant('popover', { routine: ROUTINE, anchor: ANCHOR }, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'popover', routine: ROUTINE, anchor: ANCHOR } });
        });

        it('falls back to dialog when no anchor', () => {
            const out = resolveRoutineVariant('popover', { routine: ROUTINE }, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: ROUTINE } });
        });

        it('falls back to dialog on mobile even with anchor', () => {
            const out = resolveRoutineVariant('popover', { routine: ROUTINE, anchor: ANCHOR }, true);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: ROUTINE } });
        });

        it('falls back to dialog when creating a new routine', () => {
            const out = resolveRoutineVariant('popover', { anchor: ANCHOR }, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: undefined } });
        });
    });

    describe('instant mode', () => {
        it('falls back to dialog for routines (no instant analog — always need title + frequency)', () => {
            const out = resolveRoutineVariant('instant', { routine: ROUTINE }, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: ROUTINE } });
        });
    });

    describe('page mode', () => {
        it('returns the page sentinel for an existing routine — caller navigates', () => {
            const out = resolveRoutineVariant('page', { routine: ROUTINE }, false);
            expect(out).toEqual({ kind: 'page', routine: ROUTINE });
        });

        it('falls back to dialog for a new routine — no routeId to navigate to yet', () => {
            const out = resolveRoutineVariant('page', {}, false);
            expect(out).toEqual({ kind: 'state', state: { kind: 'dialog', routine: undefined } });
        });

        it('still routes to page on mobile', () => {
            const out = resolveRoutineVariant('page', { routine: ROUTINE }, true);
            expect(out).toEqual({ kind: 'page', routine: ROUTINE });
        });
    });
});
