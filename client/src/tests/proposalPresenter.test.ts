/** Tests for the pure proposal presenter (`src/lib/proposalPresenter.ts`). */
import { describe, expect, it } from 'vitest';
import type { ClarifyProposal, ProposedItemPatch } from '../api/assistApi';
import { appliableSideEffect, presentPatch } from '../lib/proposalPresenter';
import type { StoredPerson, StoredWorkContext } from '../types/MyDB';

const people: StoredPerson[] = [
    { _id: 'p1', userId: 'u', name: 'Dana', createdTs: '', updatedTs: '' },
    { _id: 'p2', userId: 'u', name: 'Marcus', createdTs: '', updatedTs: '' },
];
const workContexts: StoredWorkContext[] = [
    { _id: 'c1', userId: 'u', name: '@phone', createdTs: '', updatedTs: '' },
    { _id: 'c2', userId: 'u', name: '@errands', createdTs: '', updatedTs: '' },
];
const ref = { people, workContexts };

describe('presentPatch', () => {
    it('emits one row per changed field, only for fields present on the patch', () => {
        const patch: ProposedItemPatch = { title: 'Follow up', status: 'nextAction' };
        const rows = presentPatch(patch, ref);
        expect(rows.map((r) => r.field)).toEqual(['title', 'status']);
        expect(rows.map((r) => r.label)).toEqual(['Title', 'Status']);
    });

    it('resolves workContextIds and peopleIds to names', () => {
        const patch: ProposedItemPatch = { workContextIds: ['c1', 'c2'], peopleIds: ['p1'] };
        const rows = presentPatch(patch, ref);
        const byField = new Map(rows.map((r) => [r.field, r.display]));
        expect(byField.get('workContextIds')).toBe('@phone, @errands');
        expect(byField.get('peopleIds')).toBe('Dana');
    });

    it('resolves waitingForPersonId to a name and falls back to the raw id for unknowns', () => {
        expect(presentPatch({ waitingForPersonId: 'p2' }, ref)[0]?.display).toBe('Marcus');
        expect(presentPatch({ peopleIds: ['ghost'] }, ref)[0]?.display).toBe('ghost');
    });

    it('maps every status to a human label', () => {
        const statuses = ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'] as const;
        const labels = statuses.map((status) => presentPatch({ status }, ref)[0]?.display);
        expect(labels).toEqual(['Inbox', 'Next Action', 'Calendar', 'Waiting For', 'Someday / Maybe', 'Done', 'Trash']);
    });

    it('formats time as minutes and booleans as Yes/No', () => {
        expect(presentPatch({ time: 30 }, ref)[0]?.display).toBe('30 min');
        expect(presentPatch({ focus: true }, ref)[0]?.display).toBe('Yes');
        expect(presentPatch({ urgent: false }, ref)[0]?.display).toBe('No');
        expect(presentPatch({ allDay: true }, ref)[0]?.display).toBe('Yes');
    });

    it('humanizes the energy enum rather than leaking the raw value', () => {
        expect(presentPatch({ energy: 'low' }, ref)[0]?.display).toBe('Low');
        expect(presentPatch({ energy: 'medium' }, ref)[0]?.display).toBe('Medium');
        expect(presentPatch({ energy: 'high' }, ref)[0]?.display).toBe('High');
    });

    it('formats date fields via dayjs', () => {
        const display = presentPatch({ expectedBy: '2026-06-06T14:30:00.000Z' }, ref)[0]?.display;
        // Locale/timezone-independent: assert the date parts are present rather than an exact string.
        expect(display).toContain('Jun');
        expect(display).toContain('2026');
    });
});

describe('appliableSideEffect', () => {
    function proposal(sideEffects: ClarifyProposal['proposedSideEffects']): ClarifyProposal {
        return { summary: 's', proposedSideEffects: sideEffects };
    }

    it('returns the first side-effect carrying an executeToken', () => {
        const result = appliableSideEffect(
            proposal([
                { kind: 'itemPatch', preview: 'no token' },
                { kind: 'itemPatch', preview: 'has token', executeToken: 'tok.1' },
            ]),
        );
        expect(result?.executeToken).toBe('tok.1');
    });

    it('returns undefined when no side-effect has a token', () => {
        expect(appliableSideEffect(proposal([{ kind: 'itemPatch', preview: 'x' }]))).toBeUndefined();
        expect(appliableSideEffect(proposal([]))).toBeUndefined();
    });
});
