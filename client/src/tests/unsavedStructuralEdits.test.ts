import { describe, expect, it } from 'vitest';
import { hasUnsavedStructuralItemEdits, isOwnerOrStructurallyEdited, itemToFormSeeds } from '../components/itemEditor/itemEditorLiveMerge';
import { hasUnsavedStructuralRoutineEdits } from '../components/routineEditor/RoutineEditorBody';
import { initFormState } from '../components/routineEditor/routineFormState';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'i1',
        userId: 'u1',
        status: 'inbox',
        title: 'Task',
        createdTs: '2026-07-01T10:00:00.000Z',
        updatedTs: '2026-07-01T10:00:00.000Z',
        ...overrides,
    };
}

function makeRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'r1',
        userId: 'u1',
        title: 'Weekly review',
        routineType: 'nextAction',
        rrule: 'FREQ=WEEKLY;INTERVAL=1',
        template: {},
        active: true,
        createdTs: '2026-07-01T10:00:00.000Z',
        updatedTs: '2026-07-01T10:00:00.000Z',
        ...overrides,
    };
}

describe('hasUnsavedStructuralItemEdits', () => {
    it('is false for an untouched form', () => {
        const seed = itemToFormSeeds(makeItem());
        expect(hasUnsavedStructuralItemEdits({ form: seed, seed, includeText: true })).toBe(false);
    });

    it('a status change is a structural edit', () => {
        const seed = itemToFormSeeds(makeItem());
        const form = { ...seed, status: 'nextAction' as const };
        expect(hasUnsavedStructuralItemEdits({ form, seed, includeText: false })).toBe(true);
    });

    it('a wizard-preselected status is a preset, not an edit', () => {
        const seed = itemToFormSeeds(makeItem());
        const form = { ...seed, status: 'nextAction' as const };
        expect(hasUnsavedStructuralItemEdits({ form, seed, initialStatus: 'nextAction', includeText: false })).toBe(false);
    });

    it('moving off the preselected status counts again', () => {
        const seed = itemToFormSeeds(makeItem());
        const form = { ...seed, status: 'calendar' as const };
        expect(hasUnsavedStructuralItemEdits({ form, seed, initialStatus: 'nextAction', includeText: false })).toBe(true);
    });

    // Pins the two non-obvious branches of ItemEditorActionsApi.isDirty, which delegates here.
    it("the 'routine' destination is always a structural edit — no item or initialStatus can equal it", () => {
        const seed = itemToFormSeeds(makeItem());
        const form = { ...seed, status: 'routine' as const };
        expect(hasUnsavedStructuralItemEdits({ form, seed, includeText: false })).toBe(true);
        expect(hasUnsavedStructuralItemEdits({ form, seed, initialStatus: 'nextAction', includeText: false })).toBe(true);
    });

    it('a title edit is NOT structural while text autosave owns it (includeText: false)', () => {
        const seed = itemToFormSeeds(makeItem());
        const form = { ...seed, title: 'Renamed task' };
        expect(hasUnsavedStructuralItemEdits({ form, seed, includeText: false })).toBe(false);
        expect(hasUnsavedStructuralItemEdits({ form, seed, includeText: true })).toBe(true);
    });

    it('only the form group the current status renders counts', () => {
        const seed = itemToFormSeeds(makeItem({ status: 'nextAction' }));
        // Calendar-group edit while the item is a nextAction — dropped on save, so not "unsaved".
        const hiddenGroupEdit = { ...seed, cal: { ...seed.cal, date: '2026-08-01' } };
        expect(hasUnsavedStructuralItemEdits({ form: hiddenGroupEdit, seed, includeText: false })).toBe(false);

        const activeGroupEdit = { ...seed, na: { ...seed.na, energy: 'high' as const } };
        expect(hasUnsavedStructuralItemEdits({ form: activeGroupEdit, seed, includeText: false })).toBe(true);
    });

    it('a preselected status does not mask a text edit when text is structural', () => {
        const seed = itemToFormSeeds(makeItem());
        const form = { ...seed, status: 'nextAction' as const, title: 'Renamed' };
        expect(hasUnsavedStructuralItemEdits({ form, seed, initialStatus: 'nextAction', includeText: true })).toBe(true);
    });

    it('title/notes count only when includeText is set (meetings with attendees)', () => {
        const seed = itemToFormSeeds(makeItem());
        const form = { ...seed, title: 'Renamed' };
        expect(hasUnsavedStructuralItemEdits({ form, seed, includeText: false })).toBe(false);
        expect(hasUnsavedStructuralItemEdits({ form, seed, includeText: true })).toBe(true);
    });
});

describe('isOwnerOrStructurallyEdited', () => {
    it('a pending owner change is always structural, with no other edit at all', () => {
        // Also fires when a REMOTE reassign moves the open item's row (liveUserId changes under an
        // untouched form) — the documented spurious "Save & next" case; pinned so it stays a
        // conscious trade-off, not an accident.
        const seed = itemToFormSeeds(makeItem());
        expect(isOwnerOrStructurallyEdited({ form: seed, seed, includeText: false, ownerUserId: 'u2', liveUserId: 'u1' })).toBe(true);
    });

    it('a matching owner delegates to the structural check', () => {
        const seed = itemToFormSeeds(makeItem());
        expect(isOwnerOrStructurallyEdited({ form: seed, seed, includeText: false, ownerUserId: 'u1', liveUserId: 'u1' })).toBe(false);
        const form = { ...seed, status: 'nextAction' as const };
        expect(isOwnerOrStructurallyEdited({ form, seed, includeText: false, ownerUserId: 'u1', liveUserId: 'u1' })).toBe(true);
    });
});

describe('hasUnsavedStructuralRoutineEdits', () => {
    it('is false for an untouched edit form', () => {
        const seed = initFormState(makeRoutine());
        expect(hasUnsavedStructuralRoutineEdits(seed, seed, true)).toBe(false);
    });

    it('a schedule edit is structural in edit mode', () => {
        const seed = initFormState(makeRoutine());
        const form = { ...seed, endsMode: 'afterN' as const, endsCount: '5' };
        expect(hasUnsavedStructuralRoutineEdits(form, seed, true)).toBe(true);
    });

    it('title/notes are excluded in edit mode (autosaved) but count in create mode', () => {
        const editSeed = initFormState(makeRoutine());
        const editForm = { ...editSeed, title: 'Renamed', notes: 'new note' };
        expect(hasUnsavedStructuralRoutineEdits(editForm, editSeed, true)).toBe(false);

        const createSeed = initFormState();
        const createForm = { ...createSeed, title: 'Brand new routine' };
        expect(hasUnsavedStructuralRoutineEdits(createForm, createSeed, false)).toBe(true);
    });

    it('an untouched create form is clean', () => {
        const seed = initFormState();
        expect(hasUnsavedStructuralRoutineEdits(seed, seed, false)).toBe(false);
    });
});
