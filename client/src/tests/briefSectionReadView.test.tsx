/** BriefSection resting state: read-only text with the pencil as the only way into the field (a
 *  typed brief is pinned, so editing must be deliberate). Rendered with renderToStaticMarkup (no
 *  DOM in this test environment), so only the initial read view is observable here — the
 *  pencil → field → pinned-notice flow is covered by e2e/item-brief-authored.spec.ts. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BriefSection } from '../components/itemEditor/BriefSection';
import {
    BRIEF_EMPTY_CLOSED_HINT,
    BRIEF_EMPTY_HINT,
    BRIEF_LABEL,
    BRIEF_PINNED_LABEL,
    BRIEF_PINNED_NOTICE,
    BRIEF_STALE_LABEL,
    type BriefLabelView,
    describeEmptyBrief,
    isBriefableItemStatus,
} from '../components/itemEditor/briefSectionLogic';
import type { BriefGeneration } from '../components/itemEditor/useBriefGeneration';
import type { BriefState } from '../lib/briefSource';

const noop = () => {};

const idleGeneration: BriefGeneration = {
    phase: 'idle',
    isOnline: true,
    notice: null,
    dismissNotice: noop,
    requestGenerate: noop,
    confirmReplace: noop,
    keepBrief: noop,
};

const pinnedLabel: BriefLabelView = { kind: 'pinned', text: BRIEF_PINNED_LABEL, tooltip: 'You wrote this brief.' };
const staleLabel: BriefLabelView = { kind: 'stale', text: BRIEF_STALE_LABEL, tooltip: 'Notes changed.' };

interface RenderOptions {
    variant?: 'field' | 'line';
    isBriefable?: boolean;
    labels?: readonly BriefLabelView[];
}

function renderBrief(value: string, state: BriefState, { variant = 'field', isBriefable = true, labels = [] }: RenderOptions = {}) {
    return renderToStaticMarkup(
        <BriefSection
            value={value}
            state={state}
            origin="model"
            labels={labels}
            onChange={noop}
            onCommit={noop}
            generation={idleGeneration}
            variant={variant}
            isBriefable={isBriefable}
        />,
    );
}

function buttonTag(html: string, label: string) {
    return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

describe('BriefSection read view', () => {
    it('rests read-only: the brief is plain text, no input, the pencil is the edit affordance', () => {
        const html = renderBrief('Renew the passport before the June trip', 'fresh');
        expect(html).toMatch(/data-testid="briefLine"[^>]*>Renew the passport before the June trip</);
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('data-testid="briefField"');
        expect(buttonTag(html, 'Edit brief')).toBeDefined();
        expect(buttonTag(html, 'Done editing brief')).toBeUndefined();
        // The text itself is not a button any more — only the pencil opens the field.
        expect(html).not.toMatch(/data-testid="briefLine"[^>]*role="button"|role="button"[^>]*data-testid="briefLine"/);
    });

    it('keeps the pinned notice out of the read view — it belongs to the open field only', () => {
        expect(renderBrief('A pinned line', 'pinnedStale')).not.toContain(BRIEF_PINNED_NOTICE);
    });

    it('shows the automatic-brief hint for an empty brief, and no hint under a declined caption', () => {
        expect(renderBrief('', 'none')).toContain(BRIEF_EMPTY_HINT);
        const declined = renderBrief('', 'declined');
        expect(declined).not.toContain(BRIEF_EMPTY_HINT);
        expect(declined).toContain('data-testid="briefDeclinedNote"');
    });

    it('puts a declined caption in the brief row itself, not on a line under an empty one', () => {
        const declined = renderBrief('', 'declined');
        expect(declined).not.toContain('data-testid="briefEmpty"');
        expect(declined).toContain('data-testid="briefDeclinedNote"');
        // The caption comes before the pencil — the row's own content slot.
        expect(declined.indexOf('data-testid="briefDeclinedNote"')).toBeLessThan(declined.indexOf('aria-label="Edit brief"'));
    });

    it('never promises an automatic brief on a closed item', () => {
        const html = renderBrief('', 'none', { isBriefable: false });
        expect(html).not.toContain(BRIEF_EMPTY_HINT);
        expect(html).toContain(BRIEF_EMPTY_CLOSED_HINT);
    });

    it('labels the editor variant and leaves the review line unlabelled', () => {
        expect(renderBrief('Line', 'fresh', { variant: 'field' })).toContain(`>${BRIEF_LABEL}<`);
        expect(renderBrief('Line', 'fresh', { variant: 'line' })).not.toContain(`>${BRIEF_LABEL}<`);
    });

    it('shows each state label as text in the brief row, before the pencil', () => {
        const html = renderBrief('A pinned line', 'pinnedStale', { variant: 'line', labels: [pinnedLabel, staleLabel] });
        expect(html).toMatch(new RegExp(`data-testid="briefPinnedLabel"[^>]*>.*${BRIEF_PINNED_LABEL}<`));
        expect(html).toMatch(new RegExp(`data-testid="briefStaleLabel"[^>]*>.*${BRIEF_STALE_LABEL}<`));
        expect(html.indexOf('data-testid="briefLine"')).toBeLessThan(html.indexOf('data-testid="briefPinnedLabel"'));
        expect(html.indexOf('data-testid="briefStaleLabel"')).toBeLessThan(html.indexOf('aria-label="Edit brief"'));
    });

    it('shows no label when there are none', () => {
        const html = renderBrief('A pinned line', 'pinnedStale');
        expect(html).not.toContain('briefPinnedLabel');
        expect(html).not.toContain('briefStaleLabel');
    });

    it('keeps the generate button available in the read view', () => {
        expect(buttonTag(renderBrief('Line', 'fresh'), 'Regenerate brief')).toBeDefined();
        expect(buttonTag(renderBrief('', 'none'), 'Generate brief')).toBeDefined();
    });
});

describe('BRIEF_PINNED_NOTICE', () => {
    it('says the brief is pinned, does not follow title/notes edits, and how to undo it', () => {
        expect(BRIEF_PINNED_NOTICE).toMatch(/pinned/i);
        expect(BRIEF_PINNED_NOTICE).toMatch(/title or notes change/);
        // Unpinning takes the confirm step too — a bare "click generate" would leave it pinned.
        expect(BRIEF_PINNED_NOTICE).toMatch(/Regenerate brief.*Replace/);
    });
});

describe('describeEmptyBrief', () => {
    it('is blank for declined, the automatic hint for open items, a plain "No brief" for closed ones', () => {
        expect(describeEmptyBrief('declined', true)).toBe('');
        expect(describeEmptyBrief('none', true)).toBe(BRIEF_EMPTY_HINT);
        expect(describeEmptyBrief('none', false)).toBe(BRIEF_EMPTY_CLOSED_HINT);
    });
});

describe('isBriefableItemStatus', () => {
    it('mirrors the server: only done and trash are out of scope', () => {
        expect(isBriefableItemStatus('done')).toBe(false);
        expect(isBriefableItemStatus('trash')).toBe(false);
        for (const status of ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe'] as const) {
            expect(isBriefableItemStatus(status)).toBe(true);
        }
    });
});
