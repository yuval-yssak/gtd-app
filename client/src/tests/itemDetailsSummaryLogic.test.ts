import { describe, expect, it } from 'vitest';
import { isDetailsSummaryShown, itemDetailFacts, ownerAccountFacts } from '../components/itemEditor/itemDetailsSummaryLogic';
import { buildItemFactLookups } from '../components/itemFactsLogic';
import type { StoredAccount, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';

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

const LOOKUPS = buildItemFactLookups(
    [person('p-dana', 'Dana'), person('p-omer', 'Omer')],
    [workContext('c-phone', 'Phone'), workContext('c-office', 'Office')],
);

function item(overrides: Partial<StoredItem>): StoredItem {
    return { _id: 'i-1', userId: 'u', status: 'inbox', title: 'x', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('itemDetailFacts', () => {
    it('lists every filled next-action field, contexts first, in the order the form shows them', () => {
        const nextAction = item({
            status: 'nextAction',
            workContextIds: ['c-phone', 'c-office'],
            peopleIds: ['p-dana'],
            energy: 'low',
            time: 15,
            urgent: true,
            expectedBy: '2026-11-21',
            ignoreBefore: '2026-11-19',
        });
        expect(itemDetailFacts(nextAction, LOOKUPS)).toEqual([
            { label: 'Contexts', value: 'Phone, Office' },
            { label: 'People', value: 'Dana' },
            { label: 'Energy', value: 'Low' },
            { label: 'Time', value: '15 min' },
            { label: 'Priority', value: 'Urgent' },
            { label: 'Expected by', value: 'Nov 21, 2026' },
            { label: 'Hidden until', value: 'Nov 19, 2026' },
        ]);
    });

    it('omits every field that has no value — the summary never shows an empty row', () => {
        expect(itemDetailFacts(item({ status: 'nextAction', energy: 'high' }), LOOKUPS)).toEqual([{ label: 'Energy', value: 'High' }]);
        expect(itemDetailFacts(item({ status: 'nextAction', urgent: false, workContextIds: [] }), LOOKUPS)).toEqual([]);
    });

    it('drops a dangling reference (a deleted person or context) instead of showing its raw id', () => {
        expect(itemDetailFacts(item({ status: 'nextAction', workContextIds: ['c-gone'], peopleIds: ['p-gone', 'p-omer'] }), LOOKUPS)).toEqual([
            { label: 'People', value: 'Omer' },
        ]);
    });

    it('leads a calendar item with when it happens and counts its guests; the location stays with the event links', () => {
        const event = item({
            status: 'calendar',
            timeStart: '2026-11-19T14:00:00',
            timeEnd: '2026-11-19T15:30:00',
            location: 'Clinic',
            attendees: [
                { email: 'a@example.com', responseStatus: 'accepted' },
                { email: 'b@example.com', responseStatus: 'needsAction' },
            ],
        });
        expect(itemDetailFacts(event, LOOKUPS)).toEqual([
            { label: 'When', value: 'Thu, Nov 19 · 2:00 pm – 3:30 pm' },
            { label: 'Guests', value: '2 guests' },
        ]);
    });

    it('says "1 guest" for a single attendee', () => {
        const event = item({ status: 'calendar', timeStart: '2026-11-19T14:00:00', attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }] });
        expect(itemDetailFacts(event, LOOKUPS)).toContainEqual({ label: 'Guests', value: '1 guest' });
    });

    it('leads a waiting-for with whom it waits on', () => {
        const waiting = item({ status: 'waitingFor', waitingForPersonId: 'p-dana', expectedBy: '2026-11-21', ignoreBefore: '2026-11-20' });
        expect(itemDetailFacts(waiting, LOOKUPS)).toEqual([
            { label: 'Waiting for', value: 'Dana' },
            { label: 'Expected by', value: 'Nov 21, 2026' },
            { label: 'Hidden until', value: 'Nov 20, 2026' },
        ]);
    });

    it('shows a someday/maybe deadline and tickler date', () => {
        expect(itemDetailFacts(item({ status: 'somedayMaybe', expectedBy: '2027-01-01', ignoreBefore: '2026-12-01' }), LOOKUPS)).toEqual([
            { label: 'Expected by', value: 'Jan 1, 2027' },
            { label: 'Hidden until', value: 'Dec 1, 2026' },
        ]);
    });

    it('has nothing to summarise for inbox, done and trash — those keep their own sections', () => {
        expect(itemDetailFacts(item({ status: 'inbox', peopleIds: ['p-dana'] }), LOOKUPS)).toEqual([]);
        expect(itemDetailFacts(item({ status: 'done', energy: 'low' }), LOOKUPS)).toEqual([]);
        expect(itemDetailFacts(item({ status: 'trash', energy: 'low' }), LOOKUPS)).toEqual([]);
    });
});

describe('isDetailsSummaryShown', () => {
    const view = { isExpanded: false, selectedStatus: 'nextAction', savedStatus: 'nextAction' } as const;

    it('summarises the saved status in the review until the user asks to edit', () => {
        expect(isDetailsSummaryShown('review', view)).toBe(true);
        expect(isDetailsSummaryShown('review', { ...view, isExpanded: true })).toBe(false);
    });

    it('never summarises outside the review — the item page always shows the form', () => {
        expect(isDetailsSummaryShown('edit', view)).toBe(false);
    });

    it('opens the form as soon as another status is picked: a new status has nothing saved to summarise', () => {
        expect(isDetailsSummaryShown('review', { ...view, selectedStatus: 'waitingFor' })).toBe(false);
    });

    it.each(['calendar', 'waitingFor', 'somedayMaybe'] as const)('summarises a saved %s item', (status) => {
        expect(isDetailsSummaryShown('review', { ...view, selectedStatus: status, savedStatus: status })).toBe(true);
    });

    it.each(['inbox', 'done', 'trash'] as const)('leaves %s alone — it has no detail form to fold', (status) => {
        expect(isDetailsSummaryShown('review', { ...view, selectedStatus: status, savedStatus: status })).toBe(false);
    });
});

describe('ownerAccountFacts', () => {
    const account = (id: string, email: string): StoredAccount => ({ id, email, name: email, image: null, provider: 'google', addedAt: 0 });

    it('names the owning account when more than one is signed in — the form hides its account picker behind the pencil', () => {
        expect(ownerAccountFacts([account('u1', 'me@example.com'), account('u2', 'work@example.com')], 'u2')).toEqual([
            { label: 'Account', value: 'work@example.com' },
        ]);
    });

    it('says nothing on a single-account device, where the owner is never in doubt', () => {
        expect(ownerAccountFacts([account('u1', 'me@example.com')], 'u1')).toEqual([]);
    });

    it('says nothing when the owner is not a signed-in account (never a raw user id)', () => {
        expect(ownerAccountFacts([account('u1', 'me@example.com'), account('u2', 'work@example.com')], 'u-gone')).toEqual([]);
    });
});
