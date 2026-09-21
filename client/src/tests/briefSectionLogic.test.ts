import { describe, expect, it } from 'vitest';
import { BriefApiError } from '../api/briefApi';
import {
    BRIEF_DECLINED_MODEL_NOTE,
    BRIEF_DECLINED_SKIPPED_NOTE,
    decideBriefCommit,
    describeDeclinedBrief,
    describeGenerateButton,
    describeGenerateError,
    describeGenerateOutcome,
    isBriefFirst,
    isBriefPinnedError,
    isDeclinedNoteVisible,
    isReplaceConfirmNeeded,
} from '../components/itemEditor/briefSectionLogic';

describe('decideBriefCommit', () => {
    it('is a no-op when the trimmed field equals the seed (retyping the saved text writes nothing)', () => {
        expect(decideBriefCommit('Passport before the trip', 'Passport before the trip')).toEqual({ kind: 'noop' });
        expect(decideBriefCommit('  Passport before the trip  ', 'Passport before the trip')).toEqual({ kind: 'noop' });
        expect(decideBriefCommit('', '')).toEqual({ kind: 'noop' });
        expect(decideBriefCommit('   ', '')).toEqual({ kind: 'noop' });
    });

    it('sets the trimmed text when it differs from the seed', () => {
        expect(decideBriefCommit('  New brief ', '')).toEqual({ kind: 'set', text: 'New brief' });
        expect(decideBriefCommit('Rewritten', 'Original')).toEqual({ kind: 'set', text: 'Rewritten' });
    });

    it('clears (rather than storing an empty string) when a previously saved brief is emptied', () => {
        expect(decideBriefCommit('', 'Original')).toEqual({ kind: 'clear' });
        expect(decideBriefCommit('   ', 'Original')).toEqual({ kind: 'clear' });
    });
});

describe('isBriefFirst', () => {
    it('leads with the brief only in review presentation, with the preference on, and a brief to show', () => {
        expect(isBriefFirst('review', true, 'fresh')).toBe(true);
        expect(isBriefFirst('review', true, 'pinnedStale')).toBe(true);
    });

    it('falls back to the plain editor when there is no brief, the preference is off, or outside the review', () => {
        expect(isBriefFirst('review', true, 'none')).toBe(false);
        expect(isBriefFirst('review', false, 'fresh')).toBe(false);
        expect(isBriefFirst('edit', true, 'fresh')).toBe(false);
    });

    it('never leads with a declined row — there is no brief line, only a caption, so the notes preview must stay', () => {
        expect(isBriefFirst('review', true, 'declined')).toBe(false);
        expect(isBriefFirst('edit', true, 'declined')).toBe(false);
    });
});

describe('describeDeclinedBrief', () => {
    it('blames the notes for a skipped row (no model call was made)', () => {
        expect(describeDeclinedBrief('skipped')).toBe(BRIEF_DECLINED_SKIPPED_NOTE);
        expect(BRIEF_DECLINED_SKIPPED_NOTE).toBe('No brief — the title already says it');
    });

    it('reports a deliberate model decision for every other origin', () => {
        expect(describeDeclinedBrief('model')).toBe(BRIEF_DECLINED_MODEL_NOTE);
        expect(BRIEF_DECLINED_MODEL_NOTE).toBe('No brief — nothing in the notes to summarise');
    });

    it('is total over BriefOrigin — an authored row can only reach the caption by being emptied server-side', () => {
        // `user`/`agent` rows always carry text today, so they never render declined; the picker
        // still answers rather than throwing, because the origin comes from stored data.
        expect(describeDeclinedBrief('user')).toBe(BRIEF_DECLINED_MODEL_NOTE);
        expect(describeDeclinedBrief('agent')).toBe(BRIEF_DECLINED_MODEL_NOTE);
    });
});

describe('isDeclinedNoteVisible', () => {
    it('shows the caption on a declined row whose field is still empty', () => {
        expect(isDeclinedNoteVisible({ state: 'declined', fieldValue: '' })).toBe(true);
    });

    it('hides it on the first keystroke — no blur, commit or save round trip involved', () => {
        expect(isDeclinedNoteVisible({ state: 'declined', fieldValue: 'P' })).toBe(false);
        expect(isDeclinedNoteVisible({ state: 'declined', fieldValue: 'Passport before June' })).toBe(false);
    });

    it('stays hidden all the way down a backspace, then returns at the last character', () => {
        // Nothing flickers mid-delete: every intermediate value is still non-empty.
        expect(isDeclinedNoteVisible({ state: 'declined', fieldValue: 'Pa' })).toBe(false);
        expect(isDeclinedNoteVisible({ state: 'declined', fieldValue: 'P' })).toBe(false);
        expect(isDeclinedNoteVisible({ state: 'declined', fieldValue: '' })).toBe(true);
    });

    it('treats a whitespace-only field as empty, matching what the commit rule would store', () => {
        expect(isDeclinedNoteVisible({ state: 'declined', fieldValue: '   ' })).toBe(true);
    });

    it('never shows for a state that is not declined, however empty the field is', () => {
        expect(isDeclinedNoteVisible({ state: 'none', fieldValue: '' })).toBe(false);
        expect(isDeclinedNoteVisible({ state: 'fresh', fieldValue: '' })).toBe(false);
        expect(isDeclinedNoteVisible({ state: 'pinnedStale', fieldValue: '' })).toBe(false);
    });
});

describe('isReplaceConfirmNeeded', () => {
    const pinned = { origin: 'user' as const, text: 'Mine' };
    const model = { origin: 'model' as const, text: 'Generated' };

    it('never asks when the field is empty, whatever row exists', () => {
        expect(isReplaceConfirmNeeded('', undefined)).toBe(false);
        expect(isReplaceConfirmNeeded('   ', pinned)).toBe(false);
    });

    it('asks when a pinned (user/agent) row with text exists', () => {
        expect(isReplaceConfirmNeeded('Mine', pinned)).toBe(true);
        expect(isReplaceConfirmNeeded('Mine', { origin: 'agent', text: 'Mine' })).toBe(true);
    });

    it('does not ask when the field just mirrors a model brief', () => {
        expect(isReplaceConfirmNeeded('Generated', model)).toBe(false);
        expect(isReplaceConfirmNeeded('  Generated ', model)).toBe(false);
    });

    it('asks when the field holds text the stored row does not (typed but not yet committed)', () => {
        expect(isReplaceConfirmNeeded('Edited by hand', model)).toBe(true);
        expect(isReplaceConfirmNeeded('Typed fresh', undefined)).toBe(true);
        expect(isReplaceConfirmNeeded('Typed fresh', { origin: 'skipped', text: null })).toBe(true);
        // A pinned row with no text is not a pinned brief — it falls through to the field-differs branch.
        expect(isReplaceConfirmNeeded('Typed', { origin: 'user', text: null })).toBe(true);
    });
});

describe('describeGenerateButton', () => {
    it('labels Generate vs Regenerate and derives the tooltip from the label', () => {
        expect(describeGenerateButton({ isRegenerate: false, isOnline: true, phase: 'idle' })).toEqual({
            label: 'Generate brief',
            tooltip: 'Generate brief with AI',
            isDisabled: false,
        });
        expect(describeGenerateButton({ isRegenerate: true, isOnline: true, phase: 'idle' })).toEqual({
            label: 'Regenerate brief',
            tooltip: 'Regenerate brief with AI',
            isDisabled: false,
        });
    });

    it('disables with the connect tooltip when offline', () => {
        expect(describeGenerateButton({ isRegenerate: false, isOnline: false, phase: 'idle' })).toEqual({
            label: 'Generate brief',
            tooltip: 'Connect to generate a brief',
            isDisabled: true,
        });
    });

    it('disables while loading or confirming, keeping the AI tooltip', () => {
        expect(describeGenerateButton({ isRegenerate: false, isOnline: true, phase: 'loading' }).isDisabled).toBe(true);
        expect(describeGenerateButton({ isRegenerate: true, isOnline: true, phase: 'confirm' }).isDisabled).toBe(true);
    });
});

describe('describeGenerateOutcome', () => {
    it('is silent for a written brief and explains skipped / stale', () => {
        expect(describeGenerateOutcome('written')).toBeNull();
        expect(describeGenerateOutcome('skipped')).toBe('Notes are too short for a brief — the title already says it');
        expect(describeGenerateOutcome('discarded_stale')).toBe('Notes changed while generating; try again');
    });
});

describe('describeGenerateError / isBriefPinnedError', () => {
    it('reports the rate limit with the Retry-After seconds, or "shortly" without them', () => {
        expect(describeGenerateError(new BriefApiError('x', { status: 429, code: 'rate_limited', retryAfterSeconds: 17 }))).toBe(
            'Too many brief generations, try again in 17 seconds',
        );
        expect(describeGenerateError(new BriefApiError('x', { status: 429, code: 'rate_limited', retryAfterSeconds: 1 }))).toBe(
            'Too many brief generations, try again in 1 second',
        );
        expect(describeGenerateError(new BriefApiError('x', { status: 429, code: 'rate_limited' }))).toBe('Too many brief generations, try again shortly');
    });

    it('reports an unconfigured server on 503', () => {
        expect(describeGenerateError(new BriefApiError('x', { status: 503, code: 'agent_unavailable' }))).toBe(
            'AI brief generation is not configured on this server',
        );
    });

    it('falls back to the generic line for other statuses and non-API throws', () => {
        expect(describeGenerateError(new BriefApiError('x', { status: 502, code: 'brief_generation_failed' }))).toBe('Could not generate a brief');
        expect(describeGenerateError(new TypeError('Failed to fetch'))).toBe('Could not generate a brief');
    });

    it('names the closed-item refusal rather than reading as a bug', () => {
        expect(describeGenerateError(new BriefApiError('x', { status: 409, code: 'brief_not_applicable' }))).toBe('Briefs are only generated for open items');
    });

    it('recognises only the 409 brief_pinned error as a pinned refusal', () => {
        expect(isBriefPinnedError(new BriefApiError('x', { status: 409, code: 'brief_pinned' }))).toBe(true);
        // Same status, different rule: a closed-item refusal must not open the replace prompt —
        // `force` is exactly what the server refuses to honour for it, so a confirm would loop.
        expect(isBriefPinnedError(new BriefApiError('x', { status: 409, code: 'brief_not_applicable' }))).toBe(false);
        expect(isBriefPinnedError(new BriefApiError('x', { status: 409 }))).toBe(false);
        expect(isBriefPinnedError(new Error('409'))).toBe(false);
    });
});
