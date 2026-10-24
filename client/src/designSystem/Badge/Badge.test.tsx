// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
});
