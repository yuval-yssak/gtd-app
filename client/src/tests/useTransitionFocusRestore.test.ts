import { describe, expect, it } from 'vitest';
import { type FocusControlLookup, resolveFocusTarget } from '../components/weeklyReview/useTransitionFocusRestore';

/**
 * The hook's DOM plumbing runs under Playwright; these tests pin the pure fallback rules through
 * the structural lookup (the node test environment has no DOM to render).
 */

interface FakeControl {
    testId: string;
    focusable?: boolean;
}

function lookupOf(controls: FakeControl[]): FocusControlLookup<FakeControl> {
    return {
        byTestId: (testId) => controls.find((control) => control.testId === testId) ?? null,
        canFocus: (control) => control.focusable !== false,
    };
}

describe('resolveFocusTarget', () => {
    it('prefers the same-testid control in the new view', () => {
        const lookup = lookupOf([{ testId: 'stageNavForward' }, { testId: 'focusKeep' }]);
        expect(resolveFocusTarget(lookup, 'stageNavForward')).toEqual({ testId: 'stageNavForward' });
    });

    it('falls back to the bar primary when the lost control is gone — Continue first', () => {
        // ▶ walked onto the end card: no forward arrow there, Continue is the primary.
        const lookup = lookupOf([{ testId: 'stageNavBack' }, { testId: 'stageContinue' }]);
        expect(resolveFocusTarget(lookup, 'stageNavForward')).toEqual({ testId: 'stageContinue' });
    });

    it('falls back when the same-testid control exists but cannot take focus', () => {
        // ◀ stepped back to the walk's start, where ◀ itself renders disabled.
        const lookup = lookupOf([{ testId: 'stageNavBack', focusable: false }, { testId: 'focusKeep' }]);
        expect(resolveFocusTarget(lookup, 'stageNavBack')).toEqual({ testId: 'focusKeep' });
    });

    it('skips a primary that cannot take focus (unticked checklist Continue) and returns null when nothing can', () => {
        const lookup = lookupOf([{ testId: 'stageContinue', focusable: false }]);
        expect(resolveFocusTarget(lookup, 'focusKeep')).toBeNull();
    });

    it('primary fallback order is Continue → clarify save → focus keep', () => {
        const lookup = lookupOf([{ testId: 'focusKeep' }, { testId: 'clarifySaveNext' }]);
        expect(resolveFocusTarget(lookup, 'revisitUndoDecision')).toEqual({ testId: 'clarifySaveNext' });
    });

    it('a container sentinel (text-field focus) is never focused itself — the bar primary takes it', () => {
        // Escape from the title field records the card container as a sentinel; the container
        // survives by testid in the new view or not, but it can never TAKE focus.
        const lookup = lookupOf([{ testId: 'clarifyStage', focusable: false }, { testId: 'clarifySaveNext' }]);
        expect(resolveFocusTarget(lookup, 'clarifyStage')).toEqual({ testId: 'clarifySaveNext' });
    });
});
