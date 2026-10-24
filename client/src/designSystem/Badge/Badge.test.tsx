// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepIndicator } from '../StepIndicator/StepIndicator';
import { Badge } from './Badge';

afterEach(cleanup);

describe('Badge', () => {
    it('caps the count at max with a plus', () => {
        render(<Badge count={120} data-testid="badge" />);
        expect(screen.getByTestId('badge').textContent).toBe('99+');
    });

    it('hides at zero unless showZero', () => {
        const { rerender } = render(<Badge count={0} data-testid="badge" />);
        expect(screen.queryByTestId('badge')).toBeNull();
        rerender(<Badge count={0} showZero data-testid="badge" />);
        expect(screen.getByTestId('badge').textContent).toBe('0');
    });
});

describe('StepIndicator', () => {
    it('marks the current step with aria-current and earlier steps as complete', () => {
        render(
            <StepIndicator
                activeIndex={1}
                steps={[
                    { key: 'collect', label: 'Collect' },
                    { key: 'inbox', label: 'Inbox' },
                    { key: 'calendar', label: 'Calendar' },
                ]}
            />,
        );
        const [collect, inbox, calendar] = screen.getAllByRole('listitem');
        if (!collect || !inbox || !calendar) throw new Error('expected three steps');
        expect(collect.hasAttribute('data-complete')).toBe(true);
        expect(inbox.getAttribute('aria-current')).toBe('step');
        expect(calendar.hasAttribute('data-complete')).toBe(false);
        expect(calendar.hasAttribute('aria-current')).toBe(false);
    });

    // A wizard walked in any order (the weekly review) knows completion per step, not by position.
    it('lets a step state its own completion, ahead of or behind the current one', () => {
        render(
            <StepIndicator
                activeIndex={1}
                steps={[
                    { key: 'collect', label: 'Collect', isComplete: false },
                    { key: 'inbox', label: 'Inbox' },
                    { key: 'calendar', label: 'Calendar', isComplete: true },
                ]}
            />,
        );
        const [collect, , calendar] = screen.getAllByRole('listitem');
        if (!collect || !calendar) throw new Error('expected three steps');
        expect(collect.hasAttribute('data-complete')).toBe(false);
        expect(calendar.hasAttribute('data-complete')).toBe(true);
    });

    // An empty stage is current AND done at once — both states must be expressed, not one dropped.
    it('keeps a completed current step marked as both current and complete', () => {
        render(
            <StepIndicator
                activeIndex={0}
                steps={[
                    { key: 'collect', label: 'Collect', isComplete: true },
                    { key: 'inbox', label: 'Inbox' },
                ]}
            />,
        );
        const [collect] = screen.getAllByRole('listitem');
        if (!collect) throw new Error('expected two steps');
        expect(collect.getAttribute('aria-current')).toBe('step');
        expect(collect.hasAttribute('data-complete')).toBe(true);
    });

    it('lays labels out below their markers on request', () => {
        render(<StepIndicator activeIndex={0} labelPlacement="below" steps={[{ key: 'collect', label: 'Collect' }]} data-testid="steps" />);
        expect(screen.getByTestId('steps').getAttribute('data-label-placement')).toBe('below');
    });

    it('stamps the step test id on every selectable step button', () => {
        const onStepSelected = vi.fn();
        render(
            <StepIndicator
                activeIndex={0}
                stepTestId="wizardStep"
                onStepSelected={onStepSelected}
                steps={[
                    { key: 'collect', label: 'Collect' },
                    { key: 'inbox', label: 'Inbox' },
                ]}
            />,
        );
        const [, inbox] = screen.getAllByTestId('wizardStep');
        if (!inbox) throw new Error('expected two step buttons');
        fireEvent.click(inbox);
        expect(onStepSelected).toHaveBeenCalledWith(1);
    });
});
