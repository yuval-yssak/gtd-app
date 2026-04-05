import type { IDBPDatabase } from 'idb';
import type { CalendarFormState, NextActionFormState, WaitingForFormState } from '../components/clarify/types';
import type { MyDB, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../types/MyDB';

/**
 * A typed stub for IDBPDatabase<MyDB>. Safe to pass to components whose internal
 * hooks are mocked or whose effects fail silently (e.g. useAccounts, which catches
 * all network/IDB errors and initialises from empty state).
 */
export const mockDb = {} as IDBPDatabase<MyDB>;

// ── Sample entities ────────────────────────────────────────────────────────────

export const samplePeople: StoredPerson[] = [
    {
        _id: 'person-1',
        userId: 'user-1',
        name: 'Alice Johnson',
        email: 'alice@example.com',
        createdTs: '2024-01-01T00:00:00.000Z',
        updatedTs: '2024-01-01T00:00:00.000Z',
    },
    {
        _id: 'person-2',
        userId: 'user-1',
        name: 'Bob Smith',
        email: 'bob@example.com',
        phone: '555-0100',
        createdTs: '2024-01-02T00:00:00.000Z',
        updatedTs: '2024-01-02T00:00:00.000Z',
    },
    {
        _id: 'person-3',
        userId: 'user-1',
        name: 'Carol Davis',
        createdTs: '2024-01-03T00:00:00.000Z',
        updatedTs: '2024-01-03T00:00:00.000Z',
    },
];

export const sampleWorkContexts: StoredWorkContext[] = [
    {
        _id: 'ctx-1',
        userId: 'user-1',
        name: 'At computer',
        createdTs: '2024-01-01T00:00:00.000Z',
        updatedTs: '2024-01-01T00:00:00.000Z',
    },
    {
        _id: 'ctx-2',
        userId: 'user-1',
        name: 'Near phone',
        createdTs: '2024-01-02T00:00:00.000Z',
        updatedTs: '2024-01-02T00:00:00.000Z',
    },
    {
        _id: 'ctx-3',
        userId: 'user-1',
        name: 'Errands',
        createdTs: '2024-01-03T00:00:00.000Z',
        updatedTs: '2024-01-03T00:00:00.000Z',
    },
];

export const sampleInboxItem: StoredItem = {
    _id: 'item-inbox-1',
    userId: 'user-1',
    status: 'inbox',
    title: 'Review the quarterly report',
    createdTs: '2024-03-01T09:00:00.000Z',
    updatedTs: '2024-03-01T09:00:00.000Z',
};

export const sampleNextActionItem: StoredItem = {
    _id: 'item-na-1',
    userId: 'user-1',
    status: 'nextAction',
    title: 'Draft the project proposal',
    energy: 'high',
    time: 60,
    focus: true,
    urgent: false,
    workContextIds: ['ctx-1'],
    peopleIds: ['person-1'],
    expectedBy: '2024-04-15',
    createdTs: '2024-03-01T09:00:00.000Z',
    updatedTs: '2024-03-01T09:00:00.000Z',
};

export const sampleCalendarItem: StoredItem = {
    _id: 'item-cal-1',
    userId: 'user-1',
    status: 'calendar',
    title: 'Team standup',
    timeStart: '2024-04-10T09:00:00.000Z',
    timeEnd: '2024-04-10T09:30:00.000Z',
    createdTs: '2024-03-01T09:00:00.000Z',
    updatedTs: '2024-03-01T09:00:00.000Z',
};

export const sampleWaitingForItem: StoredItem = {
    _id: 'item-wf-1',
    userId: 'user-1',
    status: 'waitingFor',
    title: 'Budget approval from finance',
    waitingForPersonId: 'person-2',
    expectedBy: '2024-04-20',
    createdTs: '2024-03-01T09:00:00.000Z',
    updatedTs: '2024-03-01T09:00:00.000Z',
};

export const sampleNextActionWithNotes: StoredItem = {
    _id: 'item-na-notes-1',
    userId: 'user-1',
    status: 'nextAction',
    title: 'Prepare presentation slides',
    notes: `# Presentation outline\n\n- **Introduction**: Set the stage with key metrics\n- **Problem statement**: What we're solving\n- **Proposed solution**: Three approaches\n  1. Option A: Quick wins\n  2. Option B: Long-term investment\n  3. Option C: Hybrid approach\n- **Timeline**: Q2 milestones\n- **Budget**: See spreadsheet for breakdown`,
    energy: 'medium',
    time: 90,
    createdTs: '2024-03-01T09:00:00.000Z',
    updatedTs: '2024-03-01T09:00:00.000Z',
};

export const sampleRoutine: StoredRoutine = {
    _id: 'routine-1',
    userId: 'user-1',
    title: 'Weekly team sync',
    routineType: 'nextAction',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    template: {
        energy: 'medium',
        time: 30,
        workContextIds: ['ctx-1'],
    },
    active: true,
    createdTs: '2024-01-01T00:00:00.000Z',
    updatedTs: '2024-01-01T00:00:00.000Z',
};

export const sampleCalendarRoutine: StoredRoutine = {
    _id: 'routine-2',
    userId: 'user-1',
    title: 'Daily standup',
    routineType: 'calendar',
    rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
    calendarItemTemplate: { timeOfDay: '09:00', duration: 15 },
    template: {},
    active: true,
    createdTs: '2024-01-01T00:00:00.000Z',
    updatedTs: '2024-01-01T00:00:00.000Z',
};

// ── Form state presets ─────────────────────────────────────────────────────────

export const emptyNextActionState: NextActionFormState = {
    ignoreBefore: '',
    workContextIds: [],
    peopleIds: [],
    energy: '',
    time: '',
    urgent: false,
    focus: false,
    expectedBy: '',
};

export const filledNextActionState: NextActionFormState = {
    ignoreBefore: '2024-04-01',
    workContextIds: ['ctx-1', 'ctx-2'],
    peopleIds: ['person-1'],
    energy: 'high',
    time: '45',
    urgent: true,
    focus: true,
    expectedBy: '2024-04-30',
};

export const emptyCalendarState: CalendarFormState = {
    date: '',
    startTime: '',
    endTime: '',
};

export const filledCalendarState: CalendarFormState = {
    date: '2024-04-15',
    startTime: '10:00',
    endTime: '11:00',
};

export const emptyWaitingForState: WaitingForFormState = {
    waitingForPersonId: '',
    expectedBy: '',
    ignoreBefore: '',
};

export const filledWaitingForState: WaitingForFormState = {
    waitingForPersonId: 'person-2',
    expectedBy: '2024-04-20',
    ignoreBefore: '2024-04-10',
};
