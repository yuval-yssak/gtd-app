import { describe, expect, it } from 'vitest';
import { emptyCalendar, emptyNextAction, emptyWaitingFor } from '../components/clarify/types';
import {
    applyCalendarForm,
    applyCalendarPatch,
    isSaveDisabled,
    mergeFormsIntoItem,
    normalizeTitleAndNotes,
    shouldDetachFromRoutine,
    stripRoutineId,
} from '../components/editItemDialogLogic';
import type { StoredItem } from '../types/MyDB';

const BASE_ITEM: StoredItem = {
    _id: 'item-1',
    userId: 'user-1',
    status: 'calendar',
    title: 'Standup',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
    timeStart: '2026-05-04T09:00:00.000Z',
    timeEnd: '2026-05-04T09:30:00.000Z',
};

describe('shouldDetachFromRoutine', () => {
    // Regression for reviewer issue C1: done/trash must NOT detach — routineId must survive so
    // the disposal path records a skipped exception (trash) or advances the series (done).
    it('returns false when moving a routine-linked calendar item to trash', () => {
        expect(shouldDetachFromRoutine('calendar', 'trash', true)).toBe(false);
    });

    it('returns false when moving a routine-linked calendar item to done', () => {
        expect(shouldDetachFromRoutine('calendar', 'done', true)).toBe(false);
    });

    it('returns true when moving a routine-linked calendar item to a live non-calendar status', () => {
        expect(shouldDetachFromRoutine('calendar', 'nextAction', true)).toBe(true);
        expect(shouldDetachFromRoutine('calendar', 'inbox', true)).toBe(true);
        expect(shouldDetachFromRoutine('calendar', 'waitingFor', true)).toBe(true);
        expect(shouldDetachFromRoutine('calendar', 'somedayMaybe', true)).toBe(true);
    });

    it('returns false when the item is still calendar (no transition)', () => {
        expect(shouldDetachFromRoutine('calendar', 'calendar', true)).toBe(false);
    });

    it('returns false when there is no routineId to detach', () => {
        expect(shouldDetachFromRoutine('calendar', 'nextAction', false)).toBe(false);
    });

    it('returns false when the previous status was not calendar', () => {
        expect(shouldDetachFromRoutine('nextAction', 'inbox', true)).toBe(false);
    });
});

describe('stripRoutineId', () => {
    it('removes routineId while preserving other fields', () => {
        const withRoutine = { ...BASE_ITEM, routineId: 'routine-1' };
        const stripped = stripRoutineId(withRoutine);
        expect(stripped.routineId).toBeUndefined();
        expect(stripped.title).toBe('Standup');
        expect(stripped._id).toBe('item-1');
    });

    it('no-ops when routineId is absent', () => {
        const stripped = stripRoutineId(BASE_ITEM);
        expect(stripped.routineId).toBeUndefined();
        expect(stripped.title).toBe('Standup');
    });
});

describe('isSaveDisabled', () => {
    it('disables save when title is blank', () => {
        expect(isSaveDisabled('   ', 'inbox', emptyCalendar, emptyWaitingFor)).toBe(true);
    });

    it('disables save for calendar status without a date', () => {
        expect(isSaveDisabled('ok', 'calendar', emptyCalendar, emptyWaitingFor)).toBe(true);
    });

    it('enables save for calendar status once a date is present', () => {
        expect(isSaveDisabled('ok', 'calendar', { ...emptyCalendar, date: '2026-05-04' }, emptyWaitingFor)).toBe(false);
    });

    it('disables save for waitingFor status without a person', () => {
        expect(isSaveDisabled('ok', 'waitingFor', emptyCalendar, emptyWaitingFor)).toBe(true);
    });

    it('enables save for waitingFor status with a person', () => {
        expect(isSaveDisabled('ok', 'waitingFor', emptyCalendar, { ...emptyWaitingFor, waitingForPersonId: 'p-1' })).toBe(false);
    });

    it('enables save for status types with no required fields', () => {
        expect(isSaveDisabled('ok', 'inbox', emptyCalendar, emptyWaitingFor)).toBe(false);
        expect(isSaveDisabled('ok', 'somedayMaybe', emptyCalendar, emptyWaitingFor)).toBe(false);
        expect(isSaveDisabled('ok', 'done', emptyCalendar, emptyWaitingFor)).toBe(false);
        expect(isSaveDisabled('ok', 'trash', emptyCalendar, emptyWaitingFor)).toBe(false);
    });

    it('disables save when the calendar end time is before the start time on the same date', () => {
        const cal = { date: '2026-05-04', startTime: '14:00', endTime: '13:00', calendarSyncConfigId: '' };
        expect(isSaveDisabled('ok', 'calendar', cal, emptyWaitingFor)).toBe(true);
    });

    it('enables save when start and end times match (zero-duration is permitted)', () => {
        const cal = { date: '2026-05-04', startTime: '14:00', endTime: '14:00', calendarSyncConfigId: '' };
        expect(isSaveDisabled('ok', 'calendar', cal, emptyWaitingFor)).toBe(false);
    });
});

describe('normalizeTitleAndNotes', () => {
    it('applies the trimmed title and sets notes when present', () => {
        const item = { ...BASE_ITEM, notes: 'old' };
        const normalized = normalizeTitleAndNotes(item, 'New title', 'new notes');
        expect(normalized.title).toBe('New title');
        expect(normalized.notes).toBe('new notes');
    });

    it('omits notes entirely when blank', () => {
        const item = { ...BASE_ITEM, notes: 'old' };
        const normalized = normalizeTitleAndNotes(item, 'New title', '');
        expect(normalized.title).toBe('New title');
        expect(normalized.notes).toBeUndefined();
        // The key must be missing, not set to undefined — exactOptionalPropertyTypes.
        expect('notes' in normalized).toBe(false);
    });
});

describe('applyCalendarForm', () => {
    // Regression for reviewer issue C2: switching the calendar picker from a specific config
    // back to Default must actually clear calendarSyncConfigId / calendarIntegrationId.
    it('clears a previously-set calendarSyncConfigId when meta picks Default', () => {
        const item: StoredItem = {
            ...BASE_ITEM,
            calendarSyncConfigId: 'old-config',
            calendarIntegrationId: 'old-integration',
        };
        const updated = applyCalendarForm(
            item,
            { date: '2026-05-04', startTime: '09:00', endTime: '09:30', calendarSyncConfigId: '' },
            // Empty options list — no option matches, so buildCalendarMeta omits the config keys entirely.
            [],
        );
        expect(updated.calendarSyncConfigId).toBeUndefined();
        expect(updated.calendarIntegrationId).toBeUndefined();
    });

    it('preserves calendarEventId and routineId so outbound push sees an existing-event edit', () => {
        const item: StoredItem = {
            ...BASE_ITEM,
            calendarEventId: 'evt-1',
            routineId: 'routine-1',
        };
        const updated = applyCalendarForm(item, { date: '2026-05-04', startTime: '10:00', endTime: '10:30', calendarSyncConfigId: '' }, []);
        expect(updated.calendarEventId).toBe('evt-1');
        expect(updated.routineId).toBe('routine-1');
    });

    it('sets the chosen config and integration IDs when meta resolves to an option', () => {
        const updated = applyCalendarForm(BASE_ITEM, { date: '2026-05-04', startTime: '09:00', endTime: '09:30', calendarSyncConfigId: 'cfg-1' }, [
            { configId: 'cfg-1', integrationId: 'int-1', userId: 'user-1', accountEmail: 'user@example.com', displayName: 'Work', isDefault: false },
        ]);
        expect(updated.calendarSyncConfigId).toBe('cfg-1');
        expect(updated.calendarIntegrationId).toBe('int-1');
    });
});

describe('mergeFormsIntoItem', () => {
    it('returns the item unchanged for statuses without status-specific fields', () => {
        for (const status of ['inbox', 'somedayMaybe', 'done', 'trash'] as const) {
            expect(mergeFormsIntoItem(BASE_ITEM, status, emptyNextAction, emptyCalendar, emptyWaitingFor, [])).toBe(BASE_ITEM);
        }
    });

    it('routes calendar status through applyCalendarForm', () => {
        const updated = mergeFormsIntoItem(
            BASE_ITEM,
            'calendar',
            emptyNextAction,
            { date: '2026-06-01', startTime: '11:00', endTime: '11:30', calendarSyncConfigId: '' },
            emptyWaitingFor,
            [],
        );
        // Any date/time change proves the calendar branch ran.
        expect(updated.timeStart).not.toBe(BASE_ITEM.timeStart);
    });
});

describe('applyCalendarPatch', () => {
    const FORM = { date: '2026-05-04', startTime: '14:00', endTime: '15:00', calendarSyncConfigId: '' };

    it('shifts endTime to preserve duration when startTime changes', () => {
        const next = applyCalendarPatch(FORM, { startTime: '15:30' });
        expect(next.startTime).toBe('15:30');
        expect(next.endTime).toBe('16:30');
    });

    it('preserves duration when start is dragged past the prior end', () => {
        const next = applyCalendarPatch(FORM, { startTime: '16:00' });
        expect(next.startTime).toBe('16:00');
        expect(next.endTime).toBe('17:00');
    });

    it('leaves endTime untouched when only endTime is edited (explicit duration change)', () => {
        const next = applyCalendarPatch(FORM, { endTime: '16:00' });
        expect(next.startTime).toBe('14:00');
        expect(next.endTime).toBe('16:00');
    });

    it('leaves endTime untouched when only date is edited (single-date form shifts both endpoints)', () => {
        const next = applyCalendarPatch(FORM, { date: '2026-05-05' });
        expect(next.endTime).toBe('15:00');
    });

    it('does not auto-shift end past midnight (form cannot represent multi-day events)', () => {
        const next = applyCalendarPatch(FORM, { startTime: '23:30' });
        // End is left at the prior value rather than wrapping to 00:30 next day, which would
        // produce timeEnd < timeStart at save time.
        expect(next.endTime).toBe('15:00');
    });

    it('skips duration math when prior endTime is missing', () => {
        const next = applyCalendarPatch({ ...FORM, endTime: '' }, { startTime: '15:00' });
        expect(next.endTime).toBe('');
    });

    it('passes through changes to calendarSyncConfigId', () => {
        const next = applyCalendarPatch(FORM, { calendarSyncConfigId: 'cfg-1' });
        expect(next).toEqual({ ...FORM, calendarSyncConfigId: 'cfg-1' });
    });
});
