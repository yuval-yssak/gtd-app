import { describe, expect, it } from 'vitest';
import { BRIEF_PINNED_LABEL, BRIEF_STALE_LABEL, type BriefLabelView, describeBriefLabels } from '../components/itemEditor/briefSectionLogic';
import { briefSourceHash } from '../lib/briefSource';
import type { BriefOrigin } from '../types/MyDB';

const item = { title: 'Renew passport', notes: 'Photos are the blocker; the form is half filled.', status: 'nextAction' as const };
const currentHash = briefSourceHash(item.title, item.notes);
const outdatedHash = briefSourceHash(item.title, 'Older notes the brief was written from.');

function labelsFor(origin: BriefOrigin, sourceHash: string, text: string | null = 'Passport before the June trip') {
    return describeBriefLabels(item, { origin, sourceHash, text });
}

function kindsOf(labels: readonly BriefLabelView[]) {
    return labels.map((label) => label.kind);
}

describe('describeBriefLabels', () => {
    it('labels nothing when there is no brief row', () => {
        expect(describeBriefLabels(item, undefined)).toEqual([]);
    });

    it.each<BriefOrigin>(['model', 'skipped'])('labels nothing for a text-less %s row, current or not — there is no brief to qualify', (origin) => {
        expect(labelsFor(origin, currentHash, null)).toEqual([]);
        expect(labelsFor(origin, outdatedHash, null)).toEqual([]);
    });

    it('labels nothing for a model brief that matches the current title and notes', () => {
        expect(labelsFor('model', currentHash)).toEqual([]);
    });

    it('labels a model brief whose title or notes moved on as stale, and says it is refreshed automatically', () => {
        const labels = labelsFor('model', outdatedHash);
        expect(kindsOf(labels)).toEqual(['stale']);
        const [stale] = labels;
        if (!stale) throw new Error('expected a stale label');
        expect(stale.text).toBe(BRIEF_STALE_LABEL);
        expect(stale.tooltip).toMatch(/changed since this brief was written/);
        expect(stale.tooltip).toMatch(/refreshed automatically/);
    });

    it('labels a current authored brief as pinned, naming who wrote it', () => {
        const byUserLabels = labelsFor('user', currentHash);
        expect(kindsOf(byUserLabels)).toEqual(['pinned']);
        const [byUser] = byUserLabels;
        const [byAgent] = labelsFor('agent', currentHash);
        if (!byUser || !byAgent) throw new Error('expected a pinned label for each authored origin');
        expect(byUser.text).toBe(BRIEF_PINNED_LABEL);
        expect(byUser.tooltip).toMatch(/^You wrote this brief/);
        expect(byAgent.tooltip).toMatch(/^An agent wrote this brief/);
        expect(byUser.tooltip).toMatch(/never rewritten automatically/);
    });

    it('labels an outdated authored brief both pinned and stale, and says it will not be rewritten', () => {
        const labels = labelsFor('user', outdatedHash);
        expect(kindsOf(labels)).toEqual(['pinned', 'stale']);
        const [, stale] = labels;
        if (!stale) throw new Error('expected a stale label');
        expect(stale.tooltip).toMatch(/changed since this brief was written/);
        expect(stale.tooltip).not.toMatch(/automatically/);
        expect(stale.tooltip).toMatch(/Edit it, or regenerate/);
    });

    it.each<BriefOrigin>(['model', 'user'])(
        'on a done item a stale %s brief promises no refresh and no regenerate — closed items are never briefed',
        (origin) => {
            const labels = describeBriefLabels({ ...item, status: 'done' }, { origin, sourceHash: outdatedHash, text: 'Line' });
            const stale = labels.at(-1);
            if (stale?.kind !== 'stale') throw new Error('expected a stale label last');
            expect(stale.tooltip).toBe('The title or notes changed since this brief was written.');
        },
    );

    it('treats a title-only edit as stale too — the hash covers the title', () => {
        expect(kindsOf(describeBriefLabels({ ...item, title: 'Renew passport today' }, { origin: 'model', sourceHash: currentHash, text: 'Line' }))).toEqual([
            'stale',
        ]);
    });
});
