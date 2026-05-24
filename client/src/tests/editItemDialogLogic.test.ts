import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { emptyCalendar, emptyNextAction, emptyWaitingFor } from '../components/clarify/types';
import {
    applyCalendarForm,
    applyCalendarPatch,
    buildEditPatch,
    isSaveDisabled,
    mergeFormsIntoItem,
    normalizeTitleAndNotes,
    notesAreEmpty,
    pickDefaultConfigForUser,
    shouldAutoFocusTitle,
    shouldDetachFromRoutine,
    stripRoutineId,
} from '../components/editItemDialogLogic';
import type { CalendarOption } from '../hooks/useCalendarOptions';
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
        const cal = { ...emptyCalendar, date: '2026-05-04', startTime: '14:00', endTime: '13:00' };
        expect(isSaveDisabled('ok', 'calendar', cal, emptyWaitingFor)).toBe(true);
    });

    it('enables save when start and end times match (zero-duration is permitted)', () => {
        const cal = { ...emptyCalendar, date: '2026-05-04', startTime: '14:00', endTime: '14:00' };
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
            { ...emptyCalendar, date: '2026-05-04', startTime: '09:00', endTime: '09:30' },
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
        const updated = applyCalendarForm(item, { ...emptyCalendar, date: '2026-05-04', startTime: '10:00', endTime: '10:30' }, []);
        expect(updated.calendarEventId).toBe('evt-1');
        expect(updated.routineId).toBe('routine-1');
    });

    it('sets the chosen config and integration IDs when meta resolves to an option', () => {
        const updated = applyCalendarForm(
            BASE_ITEM,
            { ...emptyCalendar, date: '2026-05-04', startTime: '09:00', endTime: '09:30', calendarSyncConfigId: 'cfg-1' },
            [{ configId: 'cfg-1', integrationId: 'int-1', userId: 'user-1', accountEmail: 'user@example.com', displayName: 'Work', isDefault: false }],
        );
        expect(updated.calendarSyncConfigId).toBe('cfg-1');
        expect(updated.calendarIntegrationId).toBe('int-1');
    });

    // Regression: an in-place edit on a calendar-linked item rendered with empty calendarOptions
    // (resolved empty: fetch failed or user has no integrations) used to drop both link IDs from
    // the saved snapshot, leaving GCal pushback with no integration to push to. Preserve the
    // existing link when the form still names it.
    it('preserves existing link IDs when calendarOptions is empty but the form still names the same config', () => {
        const item: StoredItem = {
            ...BASE_ITEM,
            calendarSyncConfigId: 'cfg-existing',
            calendarIntegrationId: 'int-existing',
            calendarEventId: 'evt-existing',
        };
        const updated = applyCalendarForm(
            item,
            { ...emptyCalendar, date: '2026-05-04', startTime: '09:00', endTime: '09:30', calendarSyncConfigId: 'cfg-existing' },
            [],
        );
        expect(updated.calendarSyncConfigId).toBe('cfg-existing');
        expect(updated.calendarIntegrationId).toBe('int-existing');
        expect(updated.calendarEventId).toBe('evt-existing');
    });

    // The preservation branch only fires when the form still names the same config. A form that
    // names a *different* config than the item carries must clear — preserving would silently
    // pin the item to the old calendar despite the form claiming otherwise.
    it('clears link IDs when the form names a different configId than the item carries (with empty options)', () => {
        const item: StoredItem = {
            ...BASE_ITEM,
            calendarSyncConfigId: 'cfg-existing',
            calendarIntegrationId: 'int-existing',
        };
        const updated = applyCalendarForm(
            item,
            { ...emptyCalendar, date: '2026-05-04', startTime: '09:00', endTime: '09:30', calendarSyncConfigId: 'cfg-different' },
            [],
        );
        expect(updated.calendarSyncConfigId).toBeUndefined();
        expect(updated.calendarIntegrationId).toBeUndefined();
    });

    // An item already corrupted by the pre-fix bug — has calendarEventId but no calendarIntegrationId —
    // cannot recover its link from the client. The preservation branch must not fabricate a missing
    // integrationId; it should fall through to clear so the corruption is at least not amplified.
    it('does not fabricate link IDs for an item that is missing calendarIntegrationId', () => {
        const item: StoredItem = {
            ...BASE_ITEM,
            calendarSyncConfigId: 'cfg-existing',
            calendarEventId: 'evt-existing',
            // calendarIntegrationId intentionally absent — already-corrupted shape.
        };
        const updated = applyCalendarForm(
            item,
            { ...emptyCalendar, date: '2026-05-04', startTime: '09:00', endTime: '09:30', calendarSyncConfigId: 'cfg-existing' },
            [],
        );
        expect(updated.calendarSyncConfigId).toBeUndefined();
        expect(updated.calendarIntegrationId).toBeUndefined();
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
            { ...emptyCalendar, date: '2026-06-01', startTime: '11:00', endTime: '11:30' },
            emptyWaitingFor,
            [],
        );
        // Any date/time change proves the calendar branch ran.
        expect(updated.timeStart).not.toBe(BASE_ITEM.timeStart);
    });

    it('persists allDay on the merged item when the form toggles all-day on', () => {
        const updated = mergeFormsIntoItem(BASE_ITEM, 'calendar', emptyNextAction, { ...emptyCalendar, date: '2026-06-01', allDay: true }, emptyWaitingFor, []);
        expect(updated.allDay).toBe(true);
        // Date-only string proves the all-day branch ran (timed would emit ISO datetimes).
        expect(updated.timeStart).toBe('2026-06-01');
        expect(updated.timeEnd).toBe('2026-06-02');
    });

    it('clears a previously-set allDay flag when the form toggles all-day off', () => {
        const previouslyAllDay: StoredItem = { ...BASE_ITEM, allDay: true, timeStart: '2026-06-01', timeEnd: '2026-06-02' };
        const updated = mergeFormsIntoItem(
            previouslyAllDay,
            'calendar',
            emptyNextAction,
            { ...emptyCalendar, date: '2026-06-01', startTime: '09:00', endTime: '10:00', allDay: false },
            emptyWaitingFor,
            [],
        );
        expect(updated.allDay).toBeUndefined();
        // exactOptionalPropertyTypes: the key must be missing, not set to undefined.
        expect('allDay' in updated).toBe(false);
    });
});

describe('applyCalendarPatch', () => {
    const FORM = { ...emptyCalendar, date: '2026-05-04', startTime: '14:00', endTime: '15:00' };

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

    it('does not run the duration-preserve trick when the form is in all-day mode', () => {
        // The duration-preserve logic mutates endTime in response to startTime — but all-day events
        // ignore startTime entirely and use endDate. Running it would produce nonsense edits to
        // a field the UI no longer renders.
        const allDayForm = { ...emptyCalendar, date: '2026-05-04', allDay: true };
        const next = applyCalendarPatch(allDayForm, { startTime: '15:30' });
        expect(next.endTime).toBe('');
    });
});

describe('pickDefaultConfigForUser', () => {
    function makeOption(overrides: Partial<CalendarOption> & Pick<CalendarOption, 'configId' | 'userId'>): CalendarOption {
        return {
            integrationId: `int-${overrides.configId}`,
            accountEmail: 'user@example.com',
            displayName: overrides.configId,
            isDefault: false,
            ...overrides,
        };
    }

    const ITEM_USER_A = { ...BASE_ITEM, userId: 'user-A', calendarSyncConfigId: 'cfg-a-original' };

    it('restores the item original configId when reverting to the original owner', () => {
        const options = [makeOption({ configId: 'cfg-b-1', userId: 'user-B', isDefault: true })];
        expect(pickDefaultConfigForUser(options, 'user-A', ITEM_USER_A)).toBe('cfg-a-original');
    });

    it('returns "" when reverting to original owner and the item had no config', () => {
        const item: StoredItem = { ...BASE_ITEM, userId: 'user-A' };
        expect(pickDefaultConfigForUser([], 'user-A', item)).toBe('');
    });

    it("picks the target account's default calendar when reassigning to a new owner", () => {
        const options = [
            makeOption({ configId: 'cfg-b-other', userId: 'user-B' }),
            makeOption({ configId: 'cfg-b-default', userId: 'user-B', isDefault: true }),
            makeOption({ configId: 'cfg-c-other', userId: 'user-C', isDefault: true }),
        ];
        expect(pickDefaultConfigForUser(options, 'user-B', ITEM_USER_A)).toBe('cfg-b-default');
    });

    // Regression: when the target account exposes exactly one calendar, the picker hides itself
    // unless we pre-select that sole option — otherwise validateReassign blocks save with
    // "Pick a calendar from {email} before saving" and there's no UI to satisfy it.
    it("falls back to the target's sole calendar when no default is flagged", () => {
        const options = [makeOption({ configId: 'cfg-b-sole', userId: 'user-B', isDefault: false })];
        expect(pickDefaultConfigForUser(options, 'user-B', ITEM_USER_A)).toBe('cfg-b-sole');
    });

    it('returns "" when the target has no calendars at all (user must connect one first)', () => {
        expect(pickDefaultConfigForUser([], 'user-B', ITEM_USER_A)).toBe('');
    });

    it('returns "" when the target has multiple calendars and none is flagged default (forces explicit pick)', () => {
        const options = [
            makeOption({ configId: 'cfg-b-1', userId: 'user-B', isDefault: false }),
            makeOption({ configId: 'cfg-b-2', userId: 'user-B', isDefault: false }),
        ];
        expect(pickDefaultConfigForUser(options, 'user-B', ITEM_USER_A)).toBe('');
    });

    it('ignores options owned by other accounts when scanning for the target default', () => {
        const options = [
            makeOption({ configId: 'cfg-a-default', userId: 'user-A', isDefault: true }),
            makeOption({ configId: 'cfg-b-sole', userId: 'user-B', isDefault: false }),
        ];
        // Reassigning A → B must pick cfg-b-sole, not cfg-a-default (which belongs to the source).
        expect(pickDefaultConfigForUser(options, 'user-B', ITEM_USER_A)).toBe('cfg-b-sole');
    });
});

describe('buildEditPatch', () => {
    const CALENDAR_ITEM: StoredItem = {
        _id: 'item-1',
        userId: 'user-1',
        status: 'calendar',
        title: 'Standup',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        notes: 'old notes',
        timeStart: '2026-05-04T09:00:00.000Z',
        timeEnd: '2026-05-04T09:30:00.000Z',
    };

    const NEXT_ACTION_ITEM: StoredItem = {
        _id: 'item-2',
        userId: 'user-1',
        status: 'nextAction',
        title: 'Pay bill',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        workContextIds: ['ctx-1'],
        peopleIds: ['p-1'],
        energy: 'medium',
        time: 15,
        urgent: false,
        focus: false,
        expectedBy: '2026-12-31',
    };

    function calForm(date: string, startTime: string, endTime: string, configId = ''): typeof emptyCalendar {
        return { ...emptyCalendar, date, startTime, endTime, calendarSyncConfigId: configId };
    }

    it('returns an empty object when nothing changed', () => {
        const patch = buildEditPatch(
            CALENDAR_ITEM,
            CALENDAR_ITEM.title,
            CALENDAR_ITEM.notes ?? '',
            'calendar',
            emptyNextAction,
            // Same wall-clock as item.timeStart/timeEnd (UTC ISO ↔ local form depends on TZ; the
            // helper compares by computed ISO so we feed back values that round-trip cleanly).
            calForm('2026-05-04', dayJsHHmm('2026-05-04T09:00:00.000Z'), dayJsHHmm('2026-05-04T09:30:00.000Z')),
            emptyWaitingFor,
        );
        expect(patch).toEqual({});
    });

    it('emits title only when the trimmed title differs from the original', () => {
        const patch = buildEditPatch(CALENDAR_ITEM, 'New title', CALENDAR_ITEM.notes ?? '', 'calendar', emptyNextAction, emptyCalendar, emptyWaitingFor);
        expect(patch.title).toBe('New title');
        expect(patch.notes).toBeUndefined();
    });

    it('emits notes when changed; emits "" when cleared', () => {
        const cleared = buildEditPatch(CALENDAR_ITEM, CALENDAR_ITEM.title, '', 'calendar', emptyNextAction, emptyCalendar, emptyWaitingFor);
        expect(cleared.notes).toBe('');

        const updated = buildEditPatch(CALENDAR_ITEM, CALENDAR_ITEM.title, 'new notes', 'calendar', emptyNextAction, emptyCalendar, emptyWaitingFor);
        expect(updated.notes).toBe('new notes');
    });

    // Calendar wall-clock — only emit timeStart/timeEnd when the resolved ISO actually changes.
    // Same configId edits are NOT in the patch (those flow via targetCalendar on the reassign call).
    it('emits timeStart/timeEnd only when the wall-clock changed', () => {
        const sameTime = buildEditPatch(
            CALENDAR_ITEM,
            CALENDAR_ITEM.title,
            CALENDAR_ITEM.notes ?? '',
            'calendar',
            emptyNextAction,
            calForm('2026-05-04', dayJsHHmm('2026-05-04T09:00:00.000Z'), dayJsHHmm('2026-05-04T09:30:00.000Z')),
            emptyWaitingFor,
        );
        expect(sameTime.timeStart).toBeUndefined();
        expect(sameTime.timeEnd).toBeUndefined();

        const newTime = buildEditPatch(
            CALENDAR_ITEM,
            CALENDAR_ITEM.title,
            CALENDAR_ITEM.notes ?? '',
            'calendar',
            emptyNextAction,
            calForm('2026-05-04', dayJsHHmm('2026-05-04T10:00:00.000Z'), dayJsHHmm('2026-05-04T11:00:00.000Z')),
            emptyWaitingFor,
        );
        expect(newTime.timeStart).toBeDefined();
        expect(newTime.timeEnd).toBeDefined();
    });

    it('emits each nextAction field 1:1 when changed; omits unchanged fields', () => {
        const naChange = {
            ignoreBefore: '',
            workContextIds: ['ctx-1', 'ctx-2'],
            peopleIds: ['p-1'], // unchanged
            energy: 'high' as const,
            time: '30',
            urgent: true,
            focus: false, // unchanged
            expectedBy: '2026-12-31', // unchanged
        };
        const patch = buildEditPatch(NEXT_ACTION_ITEM, NEXT_ACTION_ITEM.title, '', 'nextAction', naChange, emptyCalendar, emptyWaitingFor);
        expect(patch.workContextIds).toEqual(['ctx-1', 'ctx-2']);
        expect(patch.peopleIds).toBeUndefined(); // unchanged
        expect(patch.energy).toBe('high');
        expect(patch.time).toBe(30);
        expect(patch.urgent).toBe(true);
        expect(patch.focus).toBeUndefined(); // unchanged from false
        expect(patch.expectedBy).toBeUndefined(); // unchanged
    });

    it('emits energy="" when the user clears a previously-set energy', () => {
        const naCleared = {
            ignoreBefore: '',
            workContextIds: NEXT_ACTION_ITEM.workContextIds ?? [],
            peopleIds: NEXT_ACTION_ITEM.peopleIds ?? [],
            energy: '' as const,
            time: '15',
            urgent: false,
            focus: false,
            expectedBy: '2026-12-31',
        };
        const patch = buildEditPatch(NEXT_ACTION_ITEM, NEXT_ACTION_ITEM.title, '', 'nextAction', naCleared, emptyCalendar, emptyWaitingFor);
        expect(patch.energy).toBe('');
    });

    it('emits time="" when the user clears a previously-set time estimate', () => {
        const naCleared = {
            ignoreBefore: '',
            workContextIds: NEXT_ACTION_ITEM.workContextIds ?? [],
            peopleIds: NEXT_ACTION_ITEM.peopleIds ?? [],
            energy: 'medium' as const,
            time: '',
            urgent: false,
            focus: false,
            expectedBy: '2026-12-31',
        };
        const patch = buildEditPatch(NEXT_ACTION_ITEM, NEXT_ACTION_ITEM.title, '', 'nextAction', naCleared, emptyCalendar, emptyWaitingFor);
        expect(patch.time).toBe('');
    });

    it('emits empty array when the user clears workContextIds or peopleIds', () => {
        const naCleared = {
            ignoreBefore: '',
            workContextIds: [],
            peopleIds: [],
            energy: 'medium' as const,
            time: '15',
            urgent: false,
            focus: false,
            expectedBy: '2026-12-31',
        };
        const patch = buildEditPatch(NEXT_ACTION_ITEM, NEXT_ACTION_ITEM.title, '', 'nextAction', naCleared, emptyCalendar, emptyWaitingFor);
        expect(patch.workContextIds).toEqual([]);
        expect(patch.peopleIds).toEqual([]);
    });

    it('treats "" as unchanged for fields that default to empty (e.g. expectedBy when unset)', () => {
        const itemNoExpectedBy: StoredItem = { ...NEXT_ACTION_ITEM };
        delete itemNoExpectedBy.expectedBy;
        const patch = buildEditPatch(
            itemNoExpectedBy,
            itemNoExpectedBy.title,
            '',
            'nextAction',
            {
                ...emptyNextAction,
                workContextIds: itemNoExpectedBy.workContextIds ?? [],
                peopleIds: itemNoExpectedBy.peopleIds ?? [],
                energy: 'medium',
                time: '15',
            },
            emptyCalendar,
            emptyWaitingFor,
        );
        expect(patch.expectedBy).toBeUndefined();
    });

    it('emits waitingForPersonId when changed (waitingFor status)', () => {
        const wfItem: StoredItem = {
            ...NEXT_ACTION_ITEM,
            status: 'waitingFor',
            waitingForPersonId: 'p-1',
        };
        delete wfItem.workContextIds;
        delete wfItem.peopleIds;
        const wf = { waitingForPersonId: 'p-2', expectedBy: '2026-12-31', ignoreBefore: '' };
        const patch = buildEditPatch(wfItem, wfItem.title, '', 'waitingFor', emptyNextAction, emptyCalendar, wf);
        expect(patch.waitingForPersonId).toBe('p-2');
    });

    // ── all-day calendar patch fields ─────────────────────────────────────────
    // Cross-account reassign of an all-day item must survive the move (Risk #5 in the plan).

    it('emits allDay=true and date-only timeStart/timeEnd when the form switches a timed item to all-day', () => {
        const cal = { ...emptyCalendar, date: '2026-05-27', allDay: true };
        const patch = buildEditPatch(CALENDAR_ITEM, CALENDAR_ITEM.title, CALENDAR_ITEM.notes ?? '', 'calendar', emptyNextAction, cal, emptyWaitingFor);
        expect(patch.allDay).toBe(true);
        expect(patch.timeStart).toBe('2026-05-27');
        expect(patch.timeEnd).toBe('2026-05-28');
    });

    it('emits allDay=false when the form switches an all-day item back to timed', () => {
        const allDayItem: StoredItem = { ...CALENDAR_ITEM, allDay: true, timeStart: '2026-05-27', timeEnd: '2026-05-28' };
        const cal = { ...emptyCalendar, date: '2026-05-27', startTime: '09:00', endTime: '10:00', allDay: false };
        const patch = buildEditPatch(allDayItem, allDayItem.title, allDayItem.notes ?? '', 'calendar', emptyNextAction, cal, emptyWaitingFor);
        expect(patch.allDay).toBe(false);
        // ISO datetimes prove the timed branch ran.
        expect(patch.timeStart).toBeDefined();
        expect(patch.timeEnd).toBeDefined();
    });

    it('omits allDay when the form stays all-day and dates are unchanged', () => {
        const allDayItem: StoredItem = { ...CALENDAR_ITEM, allDay: true, timeStart: '2026-05-27', timeEnd: '2026-05-28' };
        const cal = { ...emptyCalendar, date: '2026-05-27', allDay: true };
        const patch = buildEditPatch(allDayItem, allDayItem.title, allDayItem.notes ?? '', 'calendar', emptyNextAction, cal, emptyWaitingFor);
        expect(patch.allDay).toBeUndefined();
        expect(patch.timeStart).toBeUndefined();
        expect(patch.timeEnd).toBeUndefined();
    });

    it('emits a multi-day timeEnd when the all-day form extends endDate', () => {
        const allDayItem: StoredItem = { ...CALENDAR_ITEM, allDay: true, timeStart: '2026-05-27', timeEnd: '2026-05-28' };
        const cal = { ...emptyCalendar, date: '2026-05-27', endDate: '2026-05-29', allDay: true };
        const patch = buildEditPatch(allDayItem, allDayItem.title, allDayItem.notes ?? '', 'calendar', emptyNextAction, cal, emptyWaitingFor);
        // Inclusive endDate 2026-05-29 → exclusive 2026-05-30.
        expect(patch.timeEnd).toBe('2026-05-30');
        // allDay flag was already set on the item, so the toggle-state diff stays silent.
        expect(patch.allDay).toBeUndefined();
    });
});

/** Local helper — rebuilds the form's HH:mm value from a stored ISO timestamp using dayjs (matches the dialog's parser). */
function dayJsHHmm(iso: string): string {
    return dayjs(iso).format('HH:mm');
}

describe('shouldAutoFocusTitle', () => {
    it('always focuses on dialog chrome', () => {
        expect(shouldAutoFocusTitle('dialog', undefined)).toBe(true);
        expect(shouldAutoFocusTitle('dialog', 'nextAction')).toBe(true);
    });

    // Page mode is read-mostly. Auto-focus pins the cursor at the end of long titles, scrolling the
    // start of the title out of view in the input — the user complaint that motivated this rule.
    it('never focuses on page chrome, regardless of initialStatus', () => {
        expect(shouldAutoFocusTitle('page', undefined)).toBe(false);
        expect(shouldAutoFocusTitle('page', 'nextAction')).toBe(false);
    });

    it('focuses on expand/popover only when initialStatus is supplied (chip click)', () => {
        expect(shouldAutoFocusTitle('expand', undefined)).toBe(false);
        expect(shouldAutoFocusTitle('expand', 'nextAction')).toBe(true);
        expect(shouldAutoFocusTitle('popover', undefined)).toBe(false);
        expect(shouldAutoFocusTitle('popover', 'calendar')).toBe(true);
    });
});

describe('notesAreEmpty', () => {
    // Page-mode notes click-to-edit reads this for both initial state (start in editor when
    // empty) and blur behaviour (stay in editor when empty so the user can keep typing).
    it('treats blank and whitespace-only strings as empty', () => {
        expect(notesAreEmpty('')).toBe(true);
        expect(notesAreEmpty('   ')).toBe(true);
        expect(notesAreEmpty('\n\t')).toBe(true);
    });

    it('treats strings with real content as non-empty', () => {
        expect(notesAreEmpty('hello')).toBe(false);
        expect(notesAreEmpty('  hello  ')).toBe(false);
        expect(notesAreEmpty('a')).toBe(false);
    });
});
