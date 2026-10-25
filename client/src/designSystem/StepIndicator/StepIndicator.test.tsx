// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepIndicator } from './StepIndicator';

afterEach(cleanup);

const STEPS = [
    { key: 'collect', label: 'Collect' },
    { key: 'inbox', label: 'Inbox' },
    { key: 'calendar', label: 'Calendar' },
];

describe('StepIndicator', () => {
    it('marks the current step with aria-current and earlier steps as complete', () => {
        render(<StepIndicator activeIndex={1} steps={STEPS} />);
        const [collect, inbox, calendar] = screen.getAllByRole('listitem');
        if (!collect || !inbox || !calendar) throw new Error('expected three steps');
        expect(collect.hasAttribute('data-complete')).toBe(true);
        expect(inbox.getAttribute('aria-current')).toBe('step');
        expect(calendar.hasAttribute('data-complete')).toBe(false);
        expect(calendar.hasAttribute('aria-current')).toBe(false);
    });

    // A screen reader announces aria-current on the element that takes focus, so on a selectable
    // strip it belongs on the button — on the <li> it is never heard while tabbing.
    it('puts aria-current on the focusable step button when steps are selectable', () => {
        render(<StepIndicator activeIndex={1} steps={STEPS} onStepSelected={vi.fn()} />);
        const [, inboxItem] = screen.getAllByRole('listitem');
        if (!inboxItem) throw new Error('expected three steps');
        expect(screen.getByRole('button', { name: /Inbox/ }).getAttribute('aria-current')).toBe('step');
        expect(screen.getByRole('button', { name: /Collect/ }).hasAttribute('aria-current')).toBe(false);
        expect(inboxItem.hasAttribute('aria-current')).toBe(false);
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
        render(<StepIndicator activeIndex={0} stepTestId="wizardStep" onStepSelected={onStepSelected} steps={STEPS.slice(0, 2)} />);
        const [, inbox] = screen.getAllByTestId('wizardStep');
        if (!inbox) throw new Error('expected two step buttons');
        fireEvent.click(inbox);
        expect(onStepSelected).toHaveBeenCalledWith(1);
    });
});
