import { describe, expect, it } from 'vitest';
import { decorateWithFieldGuidance, FIELD_COMPLETENESS_GUIDANCE, fieldGuidanceFor } from '../tools/fieldGuidance.js';

/**
 * The guidance block is advisory metadata the model reads after a write; these tests pin WHEN it
 * appears (which status, which empty fields) and that a complete item never carries it, so the
 * nudge can't degrade into noise on every response.
 */

const nextAction = (overrides: Record<string, unknown> = {}) => ({ _id: 'na1', status: 'nextAction', title: 'Call plumber', ...overrides });

describe('fieldGuidanceFor', () => {
    it('lists energy, time and workContextIds on a bare nextAction', () => {
        const guidance = fieldGuidanceFor(nextAction());
        expect(guidance?.missing).toEqual(['energy', 'time', 'workContextIds']);
        expect(guidance?.hint).toContain('Missing: energy, time, workContextIds.');
        expect(guidance?.hint).toContain('gtd_list_work_contexts');
    });

    it('lists only the fields that are still empty', () => {
        const guidance = fieldGuidanceFor(nextAction({ energy: 'low', workContextIds: ['wc1'] }));
        expect(guidance?.missing).toEqual(['time']);
    });

    it('treats an empty workContextIds array as missing', () => {
        expect(fieldGuidanceFor(nextAction({ energy: 'low', time: 5, workContextIds: [] }))?.missing).toEqual(['workContextIds']);
    });

    it('accepts time: 0 as a deliberate estimate, not a gap', () => {
        expect(fieldGuidanceFor(nextAction({ energy: 'low', time: 0, workContextIds: ['wc1'] }))).toBeNull();
    });

    it('returns null for a fully populated nextAction', () => {
        expect(fieldGuidanceFor(nextAction({ energy: 'high', time: 30, workContextIds: ['wc1'] }))).toBeNull();
    });

    it('asks for expectedBy on a waitingFor item, and is satisfied once set', () => {
        const waiting = { _id: 'w1', status: 'waitingFor', waitingForPersonId: 'p1' };
        expect(fieldGuidanceFor(waiting)?.missing).toEqual(['expectedBy']);
        expect(fieldGuidanceFor(waiting)?.hint).toContain('`expectedBy` (YYYY-MM-DD)');
        expect(fieldGuidanceFor({ ...waiting, expectedBy: '2026-10-20' })).toBeNull();
        // A whitespace-only date is as empty as none.
        expect(fieldGuidanceFor({ ...waiting, expectedBy: '   ' })?.missing).toEqual(['expectedBy']);
    });

    it('asks for location on a Google-linked calendar item and names the event to set it on', () => {
        const linked = { _id: 'c1', status: 'calendar', timeStart: '2026-10-07T10:00:00', calendarEventId: 'gcal-evt-1' };
        const guidance = fieldGuidanceFor(linked);
        expect(guidance?.missing).toEqual(['location']);
        expect(guidance?.hint).toContain('calendarEventId gcal-evt-1');
        expect(guidance?.hint).toContain('read-only');
    });

    it('stays silent on a calendar item with no Google link — there is nowhere to set a location', () => {
        expect(fieldGuidanceFor({ _id: 'c2', status: 'calendar', timeStart: '2026-10-07T10:00:00' })).toBeNull();
        expect(fieldGuidanceFor({ _id: 'c2', status: 'calendar', calendarEventId: '' })).toBeNull();
    });

    it('is silent on a linked calendar item that already has a location', () => {
        expect(fieldGuidanceFor({ _id: 'c3', status: 'calendar', calendarEventId: 'gcal-evt-3', location: 'Room 4B' })).toBeNull();
    });

    it('never nudges inbox, somedayMaybe, done or trash items', () => {
        for (const status of ['inbox', 'somedayMaybe', 'done', 'trash']) {
            expect(fieldGuidanceFor({ _id: 'x', status })).toBeNull();
        }
    });

    it('ignores a payload without a string status', () => {
        expect(fieldGuidanceFor({ _id: 'x' })).toBeNull();
        expect(fieldGuidanceFor({ _id: 'x', status: 42 })).toBeNull();
    });
});

describe('decorateWithFieldGuidance', () => {
    it('stamps fieldGuidance onto a gtd_update_item response that needs it', () => {
        const decorated = decorateWithFieldGuidance('gtd_update_item', nextAction()) as { fieldGuidance?: { missing: string[] } };
        expect(decorated.fieldGuidance?.missing).toEqual(['energy', 'time', 'workContextIds']);
    });

    it('returns the same object when nothing is missing', () => {
        const complete = nextAction({ energy: 'low', time: 10, workContextIds: ['wc1'] });
        expect(decorateWithFieldGuidance('gtd_update_item', complete)).toBe(complete);
    });

    it('leaves read tools alone so a lookup never tempts the model into unrequested edits', () => {
        const bare = nextAction();
        expect(decorateWithFieldGuidance('gtd_get_item', bare)).toBe(bare);
        expect(decorateWithFieldGuidance('gtd_list_items', { items: [bare] })).toEqual({ items: [bare] });
    });

    it('passes non-record payloads through untouched', () => {
        expect(decorateWithFieldGuidance('gtd_update_item', null)).toBeNull();
        expect(decorateWithFieldGuidance('gtd_update_item', [nextAction()])).toEqual([nextAction()]);
    });
});

describe('FIELD_COMPLETENESS_GUIDANCE', () => {
    it('names every guided field and the response key the model should look for', () => {
        for (const needle of ['`energy`', '`time`', '`workContextIds`', '`expectedBy`', '`location`', 'fieldGuidance']) {
            expect(FIELD_COMPLETENESS_GUIDANCE).toContain(needle);
        }
    });
});
