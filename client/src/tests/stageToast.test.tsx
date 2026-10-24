// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StageToast, useStageToast } from '../components/weeklyReview/useStageToast';

afterEach(cleanup);

/** Exposes the hook's two raisers as buttons so a test can drive it like the stages do. */
function StageToastHost() {
    const stageToast = useStageToast();
    return (
        <>
            <button type="button" onClick={() => stageToast.showNotice('Read-only Gmail event')}>
                notice
            </button>
            <button type="button" onClick={() => stageToast.showError('Could not pause the routine')}>
                error
            </button>
            <StageToast {...stageToast.toastProps} />
        </>
    );
}

describe('useStageToast', () => {
    // A failure must interrupt (role="alert"); routine notices stay polite.
    it('announces a failure assertively', () => {
        render(<StageToastHost />);
        act(() => screen.getByRole('button', { name: 'error' }).click());
        expect(screen.getByRole('alert').textContent).toContain('Could not pause the routine');
    });

    it('keeps an informational notice polite', () => {
        render(<StageToastHost />);
        act(() => screen.getByRole('button', { name: 'notice' }).click());
        expect(screen.getByText('Read-only Gmail event')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
