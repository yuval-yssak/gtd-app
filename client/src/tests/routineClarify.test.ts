import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { buildRoutineFieldsFromClarify, canClarifyToRoutine, isClarifyToRoutineSaveDisabled, itemToRoutineForm } from '../components/clarify/routineClarify';
import { initFormState } from '../components/routineEditor/routineFormState';
import type { CalendarOption } from '../hooks/useCalendarOptions';
import type { StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem> = {}): StoredItem {
    const now = dayjs().toISOString();
    return {
        _id: 'item-1',
        userId: 'user-1',
        status: 'inbox',
        title: 'Water the plants',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeCalendarOption(overrides: Partial<CalendarOption> = {}): CalendarOption {
    return {
        configId: 'cfg-1',
        integrationId: 'int-1',
        displayName: 'Primary',
        accountEmail: 'a@example.com',
        userId: 'user-1',
        isDefault: true,
        ...overrides,
    };
}

describe('canClarifyToRoutine', () => {
    it('is offered only for inbox items', () => {
        expect(canClarifyToRoutine(makeItem())).toBe(true);
        for (const status of ['nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'] as const) {
            expect(canClarifyToRoutine(makeItem({ status }))).toBe(false);
        }
    });

    it('refuses the destination once the live item has left the inbox (stale-selection guard)', () => {
        // onSave re-validates against the live item — a remote clarify mid-edit must not convert.
        expect(canClarifyToRoutine({ status: 'nextAction' })).toBe(false);
    });

    it('is not offered for a routine-generated item parked back in the inbox', () => {
        // Converting it would advance the OLD routine with no undo — see offerClarifyToRoutineUndo.
        expect(canClarifyToRoutine(makeItem({ routineId: 'routine-1' }))).toBe(false);
    });
});

describe('itemToRoutineForm', () => {
    it('seeds pure defaults for a bare inbox item', () => {
        const form = itemToRoutineForm(makeItem());
        expect(form).toEqual(initFormState());
    });

    it('carries the item’s nextAction metadata into the routine template fields', () => {
        const form = itemToRoutineForm(
            makeItem({
                workContextIds: ['wc-1', 'wc-2'],
                peopleIds: ['p-1'],
                energy: 'high',
                time: 30,
                focus: true,
                urgent: true,
            }),
        );
        expect(form.workContextIds).toEqual(['wc-1', 'wc-2']);
        expect(form.peopleIds).toEqual(['p-1']);
        expect(form.energy).toBe('high');
        expect(form.time).toBe('30');
        expect(form.focus).toBe(true);
        expect(form.urgent).toBe(true);
        // Title/notes stay empty — the item editor owns them.
        expect(form.title).toBe('');
        expect(form.notes).toBe('');
    });
});

describe('buildRoutineFieldsFromClarify', () => {
    it('builds a nextAction routine payload with the item title/notes and form metadata', () => {
        const item = makeItem({ notes: 'Use the small watering can' });
        const form = { ...itemToRoutineForm(item), rrule: 'FREQ=WEEKLY;BYDAY=MO', energy: 'low' as const, workContextIds: ['wc-1'] };

        const fields = buildRoutineFieldsFromClarify(item, form, []);

        expect(fields.title).toBe('Water the plants');
        expect(fields.routineType).toBe('nextAction');
        expect(fields.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        expect(fields.template).toEqual({ workContextIds: ['wc-1'], energy: 'low', notes: 'Use the small watering can' });
        expect(fields.recurrenceAnchor).toBe('floating');
        expect(fields.calendarItemTemplate).toBeUndefined();
        expect(fields.startDate).toBeUndefined();
    });

    it('appends the Ends clause to the rrule', () => {
        const item = makeItem();
        const onDate = { ...itemToRoutineForm(item), endsMode: 'onDate' as const, endsDate: '2027-01-31' };
        expect(buildRoutineFieldsFromClarify(item, onDate, []).rrule).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20270131T235959Z');

        const afterN = { ...itemToRoutineForm(item), endsMode: 'afterN' as const, endsCount: '5' };
        expect(buildRoutineFieldsFromClarify(item, afterN, []).rrule).toBe('FREQ=DAILY;INTERVAL=1;COUNT=5');
    });

    it('builds a calendar routine payload with the calendar link and no recurrenceAnchor', () => {
        const item = makeItem();
        const form = {
            ...itemToRoutineForm(item),
            routineType: 'calendar' as const,
            timeOfDay: '07:30',
            duration: '45',
            calendarSyncConfigId: 'cfg-1',
        };

        const fields = buildRoutineFieldsFromClarify(item, form, [makeCalendarOption()]);

        expect(fields.routineType).toBe('calendar');
        expect(fields.calendarItemTemplate).toEqual({ timeOfDay: '07:30', duration: 45 });
        expect(fields.calendarSyncConfigId).toBe('cfg-1');
        expect(fields.calendarIntegrationId).toBe('int-1');
        // recurrenceAnchor is nextAction-only — a calendar payload must not carry it.
        expect('recurrenceAnchor' in fields).toBe(false);
    });

    it('emits an all-day calendarItemTemplate when the form is all-day', () => {
        const item = makeItem();
        const form = { ...itemToRoutineForm(item), routineType: 'calendar' as const, allDay: true };
        expect(buildRoutineFieldsFromClarify(item, form, []).calendarItemTemplate).toEqual({ allDay: true });
    });

    it('carries the form startDate when set', () => {
        const item = makeItem();
        const form = { ...itemToRoutineForm(item), startDate: '2027-03-01' };
        expect(buildRoutineFieldsFromClarify(item, form, []).startDate).toBe('2027-03-01');
    });

    it('lets the item notes win over routine-form notes, and never promotes form notes silently', () => {
        const withNotes = makeItem({ notes: 'From the item' });
        const straggler = { ...itemToRoutineForm(withNotes), notes: 'From the form' };
        expect(buildRoutineFieldsFromClarify(withNotes, straggler, []).template.notes).toBe('From the item');

        // No item notes → template notes stay unset even if the form somehow carries text.
        const withoutNotes = makeItem();
        expect(buildRoutineFieldsFromClarify(withoutNotes, straggler, []).template.notes).toBeUndefined();
    });
});

describe('isClarifyToRoutineSaveDisabled', () => {
    it('requires a title and an rrule', () => {
        const form = initFormState();
        expect(isClarifyToRoutineSaveDisabled('Water the plants', form)).toBe(false);
        expect(isClarifyToRoutineSaveDisabled('   ', form)).toBe(true);
        expect(isClarifyToRoutineSaveDisabled('Water the plants', { ...form, rrule: '' })).toBe(true);
    });

    it('requires a time-of-day only for timed calendar routines', () => {
        const calendarForm = { ...initFormState(), routineType: 'calendar' as const, timeOfDay: '' };
        expect(isClarifyToRoutineSaveDisabled('t', calendarForm)).toBe(true);
        expect(isClarifyToRoutineSaveDisabled('t', { ...calendarForm, allDay: true })).toBe(false);
        expect(isClarifyToRoutineSaveDisabled('t', { ...calendarForm, timeOfDay: '09:00' })).toBe(false);
    });
});
