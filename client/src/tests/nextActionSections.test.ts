import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { compareNextActions } from '../lib/compareNextActions';
import { flatIndexOfSlot, flattenSections, groupIntoSections, NO_DATE_SECTION_KEY, sectionLabel } from '../lib/nextActionSections';
import type { StoredItem } from '../types/MyDB';

const TODAY = '2026-10-23';

function makeItem(overrides: Partial<StoredItem> & { _id: string }): StoredItem {
    return {
        userId: 'u',
        status: 'nextAction',
        title: overrides._id,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('sectionLabel', () => {
    it('names today, tomorrow, future days, overdue days and the undated tail', () => {
        expect(sectionLabel(TODAY, TODAY)).toBe('Today');
        expect(sectionLabel('2026-10-24', TODAY)).toBe('Tomorrow');
        expect(sectionLabel('2026-10-30', TODAY)).toBe('Fri Oct 30');
        expect(sectionLabel('2026-10-20', TODAY)).toBe('Overdue · Tue Oct 20');
        expect(sectionLabel(null, TODAY)).toBe('No date');
    });

    it('rolls at midnight: yesterday\'s "Today" becomes overdue once todayIso advances', () => {
        expect(sectionLabel(TODAY, dayjs(TODAY).add(1, 'day').format('YYYY-MM-DD'))).toBe(`Overdue · ${dayjs(TODAY).format('ddd MMM D')}`);
    });
});

describe('groupIntoSections', () => {
    it('splits a sorted list into one section per expected day, "No date" last, each in order (D3: one section per overdue date)', () => {
        const items = [
            makeItem({ _id: 'undated', rank: 'a0' }),
            makeItem({ _id: 'today', expectedBy: TODAY, rank: 'a1' }),
            makeItem({ _id: 'overdueOlder', expectedBy: '2026-10-19' }),
            makeItem({ _id: 'overdue', expectedBy: '2026-10-20' }),
            // Local wall-clock datetime (no offset) so the day key is the same in every test TZ.
            makeItem({ _id: 'todayFirst', expectedBy: `${TODAY}T15:00:00`, rank: 'a0' }),
            makeItem({ _id: 'nextWeek', expectedBy: '2026-10-30' }),
        ].sort(compareNextActions);
        const sections = groupIntoSections(items, TODAY);
        expect(sections.map((section) => [section.key, section.label, section.isOverdue, section.items.map((item) => item._id)])).toEqual([
            ['2026-10-19', 'Overdue · Mon Oct 19', true, ['overdueOlder']],
            ['2026-10-20', 'Overdue · Tue Oct 20', true, ['overdue']],
            [TODAY, 'Today', false, ['todayFirst', 'today']],
            ['2026-10-30', 'Fri Oct 30', false, ['nextWeek']],
            [NO_DATE_SECTION_KEY, 'No date', false, ['undated']],
        ]);
    });

    it('mixed date-only and datetime expectedBy values land in the same section', () => {
        const items = [makeItem({ _id: 'a', expectedBy: '2026-10-24' }), makeItem({ _id: 'b', expectedBy: '2026-10-24T09:00:00' })];
        expect(groupIntoSections(items, TODAY)).toHaveLength(1);
    });

    it('an empty list yields no sections', () => {
        expect(groupIntoSections([], TODAY)).toEqual([]);
    });
});

describe('flattenSections / flatIndexOfSlot', () => {
    const items = [
        makeItem({ _id: 'd1', expectedBy: TODAY, rank: 'a0' }),
        makeItem({ _id: 'u1', rank: 'a0' }),
        makeItem({ _id: 'u2', rank: 'a1' }),
        makeItem({ _id: 'u3', rank: 'a2' }),
    ];
    const rows = flattenSections(groupIntoSections(items, TODAY));

    it('emits a header row before each section and marks the last item of a section', () => {
        expect(rows.map((row) => (row.kind === 'header' ? `H:${row.section.key}` : `${row.item._id}${row.isLastInSection ? '*' : ''}`))).toEqual([
            `H:${TODAY}`,
            'd1*',
            'H:no-date',
            'u1',
            'u2',
            'u3*',
        ]);
    });

    it('maps a grab-mode slot to the virtualizer row currently at that position', () => {
        // No-date items start at flat index 3. Slot 1 → the row at position 1 (u2): row 4.
        expect(flatIndexOfSlot(rows, 'no-date', 1)).toBe(4);
        // Slot 0 → row 3.
        expect(flatIndexOfSlot(rows, 'no-date', 0)).toBe(3);
        // Clamped to the section.
        expect(flatIndexOfSlot(rows, 'no-date', 99)).toBe(5);
        expect(flatIndexOfSlot(rows, 'missing', 0)).toBe(0);
    });
});
