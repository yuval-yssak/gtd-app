import { describe, expect, it } from 'vitest';
import { BriefApiError } from '../api/briefApi';
import {
    decideBriefCommit,
    describeGenerateButton,
    describeGenerateError,
    describeGenerateOutcome,
    isBriefFirst,
    isBriefPinnedError,
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

    it('recognises only the 409 brief_pinned error as a pinned refusal', () => {
        expect(isBriefPinnedError(new BriefApiError('x', { status: 409, code: 'brief_pinned' }))).toBe(true);
        expect(isBriefPinnedError(new BriefApiError('x', { status: 409 }))).toBe(false);
        expect(isBriefPinnedError(new Error('409'))).toBe(false);
    });
});
