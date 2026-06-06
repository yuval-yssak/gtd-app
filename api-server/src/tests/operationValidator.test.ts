import { describe, expect, it } from 'vitest';
import { assertStatusFieldRules, type ItemSnapshot, validateOperation, validateSnapshot } from '../schemas/operations/index.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';

const baseItem = (overrides: Partial<ItemSnapshot> = {}): ItemSnapshot => ({
    _id: 'item-1',
    user: 'user-1',
    status: 'inbox',
    title: 'buy milk',
    createdTs: '2026-05-08T10:00:00Z',
    updatedTs: '2026-05-08T10:00:00Z',
    ...overrides,
});

const baseOp = (overrides: Partial<Omit<OperationInterface, 'snapshot'>> = {}, snapshot?: ItemSnapshot) => ({
    entityType: 'item' as const,
    opType: 'create' as const,
    entityId: 'item-1',
    snapshot: snapshot ?? baseItem(),
    ...overrides,
});

describe('validateOperation — happy path', () => {
    it('accepts an inbox item with only universal fields', () => {
        const result = validateOperation(baseOp());
        expect(result.ok).toBe(true);
    });

    it('accepts a nextAction item with workContextIds + energy + ignoreBefore', () => {
        const snapshot = baseItem({
            status: 'nextAction',
            workContextIds: ['ctx-1'],
            energy: 'low',
            ignoreBefore: '2026-05-09',
        });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    it('accepts a calendar item with timeStart/timeEnd/calendarEventId', () => {
        const snapshot = baseItem({
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00Z',
            timeEnd: '2026-05-09T11:00:00Z',
            calendarEventId: 'gcal-evt',
            calendarIntegrationId: 'integ-1',
        });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    it('accepts floating-wall-clock timeStart/timeEnd (no Z) on a calendar item', () => {
        // Routine generator and GCal use floating local times paired with a separate timeZone.
        // See `routineItemRegeneration.ts:58-59` and `GoogleCalendarProvider.ts:413`.
        const snapshot = baseItem({
            status: 'calendar',
            timeStart: '2026-07-07T10:45:00',
            timeEnd: '2026-07-07T11:00:00',
        });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    // Regression: all-day calendar items store a date-only `YYYY-MM-DD` for timeStart/timeEnd
    // (the GCal `{ date }` form). The floatingDateTime schema used to require a `T`, so marking
    // an all-day calendar item done 400'd on `snapshot.timeStart` and the completion never landed.
    it('accepts date-only timeStart/timeEnd on a calendar item (all-day)', () => {
        const snapshot = baseItem({
            status: 'calendar',
            timeStart: '2026-05-27',
            timeEnd: '2026-05-28',
            allDay: true,
        });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    it('accepts date-only timeStart/timeEnd on a done item (all-day completion)', () => {
        const snapshot = baseItem({ status: 'done', timeStart: '2026-05-27', timeEnd: '2026-05-28', allDay: true });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    // Guards the date-only branch of floatingDateTime: a malformed date (un-padded month) must still
    // be rejected, so widening to YYYY-MM-DD didn't open the gate to arbitrary strings.
    it('rejects a malformed date-only timeStart (un-padded month)', () => {
        const snapshot = baseItem({ status: 'calendar', timeStart: '2026-5-9' });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
    });

    it('rejects floating wall-clock for createdTs (server timestamps must be UTC)', () => {
        const snapshot = baseItem({ createdTs: '2026-05-08T10:00:00' });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
    });

    it('accepts an item.delete with snapshot=null', () => {
        const result = validateOperation({ entityType: 'item', opType: 'delete', entityId: 'x', snapshot: null });
        expect(result.ok).toBe(true);
    });

    // Regression: events Google auto-creates from Gmail attachments arrive with
    // `eventType: 'fromGmail'`. The strict enum used to reject this, so every sync push that
    // echoed such an item back to the server 400'd at the validator and never produced an op
    // — the user's done/trash/move never landed. Keep one test per accepted value so a future
    // Google-side addition is caught explicitly here, not in production.
    for (const eventType of ['default', 'outOfOffice', 'focusTime', 'workingLocation', 'fromGmail'] as const) {
        it(`accepts a calendar item with eventType='${eventType}'`, () => {
            const snapshot = baseItem({
                status: 'calendar',
                timeStart: '2026-05-09T10:00:00Z',
                timeEnd: '2026-05-09T11:00:00Z',
                calendarEventId: 'gcal-evt',
                eventType,
            });
            const result = validateOperation(baseOp({}, snapshot));
            expect(result.ok).toBe(true);
        });
    }
});

describe('validateOperation — status×field matrix', () => {
    it('rejects ignoreBefore on a calendar item (the new rule)', () => {
        const snapshot = baseItem({
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00Z',
            timeEnd: '2026-05-09T11:00:00Z',
            ignoreBefore: '2026-05-08',
        });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('status_field_violation');
        expect(result.extra?.field).toBe('ignoreBefore');
        expect(result.extra?.status).toBe('calendar');
    });

    it('rejects timeStart on an inbox item', () => {
        const snapshot = baseItem({ timeStart: '2026-05-09T10:00:00Z' });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.extra?.field).toBe('timeStart');
    });

    it('rejects waitingForPersonId on a nextAction item', () => {
        const snapshot = baseItem({ status: 'nextAction', waitingForPersonId: 'p-1' });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.extra?.field).toBe('waitingForPersonId');
    });

    it('rejects energy on a waitingFor item', () => {
        const snapshot = baseItem({ status: 'waitingFor', energy: 'low' });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.extra?.field).toBe('energy');
    });

    it('rejects allDay on a nextAction item (calendar-only flag)', () => {
        // allDay is meaningful only on a calendar event; an inert flag on a to-do is a sign of an
        // agent/client bug, so the matrix rejects it on active non-calendar statuses.
        const snapshot = baseItem({ status: 'nextAction', allDay: true });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.extra?.field).toBe('allDay');
    });

    it('accepts allDay on a calendar item', () => {
        const snapshot = baseItem({ status: 'calendar', timeStart: '2026-05-27', timeEnd: '2026-05-28', allDay: true });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    it('preserves allDay on a trash item (audit trail)', () => {
        const snapshot = baseItem({ status: 'trash', timeStart: '2026-05-27', timeEnd: '2026-05-28', allDay: true });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    it('preserves status-specific fields on a done item (audit trail)', () => {
        // `done` is archival — it keeps whatever fields the item carried at completion so
        // historical queries (timeStart for routine instances, energy for retrospectives) work.
        const snapshot = baseItem({ status: 'done', energy: 'low', timeStart: '2026-05-09T10:00:00Z', timeEnd: '2026-05-09T11:00:00Z', allDay: true });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });

    it('accepts a waitingFor item with peopleIds + waitingForPersonId + expectedBy', () => {
        const snapshot = baseItem({
            status: 'waitingFor',
            waitingForPersonId: 'p-1',
            peopleIds: ['p-1'],
            expectedBy: '2026-05-15',
        });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(true);
    });
});

describe('validateOperation — structural errors', () => {
    it('rejects an unknown entityType', () => {
        const result = validateOperation({ entityType: 'unknown', opType: 'create', entityId: 'x', snapshot: {} } as unknown);
        expect(result.ok).toBe(false);
    });

    it('rejects an item op missing required _id', () => {
        const snapshot = baseItem();
        const { _id, ...rest } = snapshot;
        void _id;
        const result = validateOperation({ entityType: 'item', opType: 'create', entityId: 'x', snapshot: rest });
        expect(result.ok).toBe(false);
    });

    it('rejects an extra unknown field on an item snapshot', () => {
        const snapshot = { ...baseItem(), bogusField: 'nope' } as ItemSnapshot;
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
    });

    it('rejects a malformed createdTs', () => {
        const snapshot = baseItem({ createdTs: 'not-a-date' });
        const result = validateOperation(baseOp({}, snapshot));
        expect(result.ok).toBe(false);
    });
});

describe('validateSnapshot — entity-only validation helper', () => {
    it('accepts a conformant item snapshot', () => {
        const result = validateSnapshot('item', 'item-1', baseItem({ status: 'nextAction', energy: 'low' }));
        expect(result.ok).toBe(true);
    });

    it('rejects an item snapshot that violates the status×field matrix', () => {
        const result = validateSnapshot(
            'item',
            'item-1',
            baseItem({ status: 'calendar', timeStart: '2026-05-09T10:00:00Z', timeEnd: '2026-05-09T11:00:00Z', ignoreBefore: '2026-05-08' }),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('status_field_violation');
    });
});

describe('validateOperation — non-item entities', () => {
    it('accepts a person.create snapshot', () => {
        const result = validateOperation({
            entityType: 'person',
            opType: 'create',
            entityId: 'p-1',
            snapshot: {
                _id: 'p-1',
                user: 'user-1',
                name: 'Alice',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            },
        });
        expect(result.ok).toBe(true);
    });

    it('accepts a workContext.update snapshot', () => {
        const result = validateOperation({
            entityType: 'workContext',
            opType: 'update',
            entityId: 'ctx-1',
            snapshot: {
                _id: 'ctx-1',
                user: 'user-1',
                name: 'at the laptop',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            },
        });
        expect(result.ok).toBe(true);
    });

    it('accepts a routine.delete with snapshot=null', () => {
        const result = validateOperation({
            entityType: 'routine',
            opType: 'delete',
            entityId: 'r-1',
            snapshot: null,
        });
        expect(result.ok).toBe(true);
    });

    // floatingDateTime is shared with routineExceptions[].newTimeStart/newTimeEnd. An all-day
    // routine instance moved to another all-day date is date-only, so the widened schema must
    // accept it here too — this pins the shared-schema coupling.
    it('accepts a routine modified-exception with date-only newTimeStart/newTimeEnd', () => {
        const result = validateOperation({
            entityType: 'routine',
            opType: 'update',
            entityId: 'r-1',
            snapshot: {
                _id: 'r-1',
                user: 'user-1',
                title: 'water plants',
                routineType: 'calendar',
                rrule: 'FREQ=DAILY',
                template: {},
                calendarItemTemplate: { timeOfDay: '00:00', duration: 1440 },
                active: true,
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
                routineExceptions: [{ date: '2026-05-27', type: 'modified', newTimeStart: '2026-05-28', newTimeEnd: '2026-05-29' }],
            },
        });
        expect(result.ok).toBe(true);
    });

    it('rejects a routine snapshot missing rrule', () => {
        const result = validateOperation({
            entityType: 'routine',
            opType: 'create',
            entityId: 'r-1',
            snapshot: {
                _id: 'r-1',
                user: 'user-1',
                title: 'water plants',
                routineType: 'nextAction',
                template: {},
                active: true,
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            },
        });
        expect(result.ok).toBe(false);
    });
});

describe('assertStatusFieldRules — exhaustive status × field matrix', () => {
    // Source of truth for the matrix lives in `schemas/operations/item.ts`. This test mirrors it
    // here exhaustively: every (status, status-specific field) cell gets one `it` with a sample
    // value, verifying allow/reject. Adding a status or field requires updating both places — the
    // duplication is the point: it makes the matrix observable from the test output.
    const ALL_STATUSES: ReadonlyArray<ItemInterface['status']> = ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'];
    const ALL_FIELDS = [
        'workContextIds',
        'peopleIds',
        'waitingForPersonId',
        'energy',
        'time',
        'focus',
        'urgent',
        'expectedBy',
        'ignoreBefore',
        'timeStart',
        'timeEnd',
        'calendarEventId',
        'calendarIntegrationId',
    ] as const;

    // `done` and `trash` are archival — they preserve whatever fields the item carried at
    // disposal so historical queries (e.g. "items completed for date X") keep working.
    const ALL_FIELDS_SET: ReadonlySet<(typeof ALL_FIELDS)[number]> = new Set(ALL_FIELDS);
    const ALLOWED: Record<ItemInterface['status'], ReadonlySet<(typeof ALL_FIELDS)[number]>> = {
        inbox: new Set(),
        nextAction: new Set(['workContextIds', 'peopleIds', 'energy', 'time', 'focus', 'urgent', 'expectedBy', 'ignoreBefore']),
        calendar: new Set(['timeStart', 'timeEnd', 'calendarEventId', 'calendarIntegrationId', 'workContextIds', 'peopleIds']),
        waitingFor: new Set(['waitingForPersonId', 'peopleIds', 'expectedBy', 'ignoreBefore']),
        somedayMaybe: new Set(),
        done: ALL_FIELDS_SET,
        trash: ALL_FIELDS_SET,
    };

    const sampleValue = (field: (typeof ALL_FIELDS)[number]): unknown => {
        switch (field) {
            case 'workContextIds':
            case 'peopleIds':
                return ['ctx-1'];
            case 'waitingForPersonId':
            case 'calendarEventId':
            case 'calendarIntegrationId':
                return 'x-1';
            case 'energy':
                return 'low';
            case 'time':
                return 30;
            case 'focus':
            case 'urgent':
                return true;
            case 'expectedBy':
            case 'ignoreBefore':
                return '2026-05-09';
            case 'timeStart':
                return '2026-05-09T10:00:00Z';
            case 'timeEnd':
                return '2026-05-09T11:00:00Z';
        }
    };

    for (const status of ALL_STATUSES) {
        for (const field of ALL_FIELDS) {
            const allowed = ALLOWED[status].has(field);
            it(`status="${status}" field="${field}" → ${allowed ? 'allowed' : 'rejected'}`, () => {
                const snapshot = baseItem({ status });
                (snapshot as Record<string, unknown>)[field] = sampleValue(field);
                const result = assertStatusFieldRules(snapshot);
                if (allowed) {
                    expect(result).toBeNull();
                } else {
                    expect(result?.field).toBe(field);
                    expect(result?.status).toBe(status);
                }
            });
        }
    }
});
