import { describe, expect, it } from 'vitest';
import { buildDoneContextLookups, doneContextSummary, doneItemContext, priorStatusOf } from '../components/doneItemContextLogic';
import type { OpenItemStatus, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';

const person = (id: string, name: string): StoredPerson => ({
    _id: id,
    userId: 'u',
    name,
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
});
const workContext = (id: string, name: string): StoredWorkContext => ({
    _id: id,
    userId: 'u',
    name,
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
});

const LOOKUPS = buildDoneContextLookups(
    [person('p-dana', 'Dana'), person('p-omer', 'Omer')],
    [workContext('c-phone', 'Phone'), workContext('c-office', 'Office')],
);

function doneItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return { _id: 'i-1', userId: 'u', status: 'done', title: 'x', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('priorStatusOf', () => {
    it('reads the recorded status when the item has one', () => {
        expect(priorStatusOf(doneItem({ statusBeforeDone: 'somedayMaybe', timeStart: '2026-10-27T14:00:00' }))).toEqual({
            status: 'somedayMaybe',
            isInferred: false,
        });
    });

    it.each<[string, Partial<StoredItem>, OpenItemStatus]>([
        ['a start time → calendar', { timeStart: '2026-10-27T14:00:00' }, 'calendar'],
        ['a waited-on person → waitingFor', { waitingForPersonId: 'p-dana' }, 'waitingFor'],
        ['work contexts → nextAction', { workContextIds: ['c-phone'] }, 'nextAction'],
        ['an energy level → nextAction', { energy: 'low' }, 'nextAction'],
        ['a time estimate → nextAction', { time: 15 }, 'nextAction'],
    ])('infers from the leftover fields of a legacy done item: %s', (_label, fields, expected) => {
        expect(priorStatusOf(doneItem(fields))).toEqual({ status: expected, isInferred: true });
    });

    it('is null when nothing tells the statuses apart (inbox vs someday/maybe leave no trace)', () => {
        expect(priorStatusOf(doneItem({ peopleIds: ['p-dana'], expectedBy: '2026-11-01' }))).toBeNull();
    });
});

describe('doneItemContext', () => {
    it('is null for an item that is not done', () => {
        expect(doneItemContext(doneItem({ status: 'calendar', timeStart: '2026-10-27T14:00:00' }), LOOKUPS)).toBeNull();
    });

    it('a calendar event leads with its start and end', () => {
        const item = doneItem({
            statusBeforeDone: 'calendar',
            timeStart: '2026-10-27T14:00:00',
            timeEnd: '2026-10-27T15:30:00',
            location: 'Clinic',
            peopleIds: ['p-dana'],
        });
        expect(doneItemContext(item, LOOKUPS)).toEqual({
            status: 'calendar',
            statusLabel: 'Calendar',
            isInferred: false,
            facts: [
                { label: 'When', value: 'Tue, Oct 27 · 2:00 pm – 3:30 pm' },
                { label: 'Location', value: 'Clinic' },
                { label: 'People', value: 'Dana' },
            ],
        });
    });

    it('an all-day event reads as all day', () => {
        const item = doneItem({ statusBeforeDone: 'calendar', allDay: true, timeStart: '2026-10-27', timeEnd: '2026-10-28' });
        expect(doneItemContext(item, LOOKUPS)?.facts[0]).toEqual({ label: 'When', value: 'Tue, Oct 27 · all day' });
    });

    it('a multi-day all-day event ends on its inclusive last day (timeEnd is exclusive)', () => {
        const item = doneItem({ statusBeforeDone: 'calendar', allDay: true, timeStart: '2026-10-27', timeEnd: '2026-10-30' });
        expect(doneItemContext(item, LOOKUPS)?.facts[0]).toEqual({ label: 'When', value: 'Tue, Oct 27 – Thu, Oct 29 · all day' });
    });

    it('a timed event with no end still shows its start', () => {
        const item = doneItem({ statusBeforeDone: 'calendar', timeStart: '2026-10-27T09:15:00' });
        expect(doneItemContext(item, LOOKUPS)?.facts[0]).toEqual({ label: 'When', value: 'Tue, Oct 27 · 9:15 am' });
    });

    it('a waiting-for names whom it waited on, then when it was expected', () => {
        const item = doneItem({ statusBeforeDone: 'waitingFor', waitingForPersonId: 'p-omer', expectedBy: '2026-11-03' });
        expect(doneItemContext(item, LOOKUPS)?.facts).toEqual([
            { label: 'Waiting for', value: 'Omer' },
            { label: 'Expected by', value: 'Nov 3, 2026' },
        ]);
    });

    it('a next action shows its contexts and people first, then energy and time', () => {
        const item = doneItem({ statusBeforeDone: 'nextAction', workContextIds: ['c-phone', 'c-office'], peopleIds: ['p-dana'], energy: 'high', time: 45 });
        expect(doneItemContext(item, LOOKUPS)?.facts).toEqual([
            { label: 'Contexts', value: 'Phone, Office' },
            { label: 'People', value: 'Dana' },
            { label: 'Energy', value: 'High' },
            { label: 'Time', value: '45 min' },
        ]);
    });

    it('drops references to people or contexts that no longer exist instead of showing ids', () => {
        const item = doneItem({ statusBeforeDone: 'nextAction', workContextIds: ['c-gone'], peopleIds: ['p-gone', 'p-dana'] });
        expect(doneItemContext(item, LOOKUPS)?.facts).toEqual([{ label: 'People', value: 'Dana' }]);
    });

    it('a someday/maybe shows its deferral dates', () => {
        const item = doneItem({ statusBeforeDone: 'somedayMaybe', expectedBy: '2026-12-01', ignoreBefore: '2026-11-15' });
        expect(doneItemContext(item, LOOKUPS)?.facts).toEqual([
            { label: 'Expected by', value: 'Dec 1, 2026' },
            { label: 'Hidden until', value: 'Nov 15, 2026' },
        ]);
    });

    it('with no knowable status lists people before the expected date', () => {
        const item = doneItem({ peopleIds: ['p-dana'], expectedBy: '2026-11-03' });
        expect(doneItemContext(item, LOOKUPS)?.facts.map((fact) => fact.label)).toEqual(['People', 'Expected by']);
    });

    it('marks an inferred status so the UI can hedge it', () => {
        expect(doneItemContext(doneItem({ timeStart: '2026-10-27T14:00:00' }), LOOKUPS)?.isInferred).toBe(true);
    });

    it('with no knowable status still lists the fields the item kept', () => {
        expect(doneItemContext(doneItem({ peopleIds: ['p-dana'] }), LOOKUPS)).toEqual({
            status: null,
            statusLabel: null,
            isInferred: true,
            facts: [{ label: 'People', value: 'Dana' }],
        });
    });

    it('is null for a done item with nothing to say — no status, no fields', () => {
        expect(doneItemContext(doneItem(), LOOKUPS)).toBeNull();
    });
});

describe('doneContextSummary', () => {
    it('is the status plus its two most prominent facts', () => {
        const context = doneItemContext(
            doneItem({ statusBeforeDone: 'nextAction', workContextIds: ['c-phone'], peopleIds: ['p-dana'], energy: 'low' }),
            LOOKUPS,
        );
        expect(context && doneContextSummary(context)).toBe('Next Action · Phone · Dana');
    });

    it('leaves the status out when it is unknown', () => {
        const context = doneItemContext(doneItem({ peopleIds: ['p-dana'] }), LOOKUPS);
        expect(context && doneContextSummary(context)).toBe('Dana');
    });

    it('a status with no facts is just the status', () => {
        const context = doneItemContext(doneItem({ statusBeforeDone: 'inbox' }), LOOKUPS);
        expect(context && doneContextSummary(context)).toBe('Inbox');
    });
});
