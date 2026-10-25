// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadioGroup } from './RadioGroup';

afterEach(cleanup);

describe('RadioGroup', () => {
    it('exposes each option as a named radio and reports the picked value', async () => {
        const onValueChange = vi.fn();
        render(
            <RadioGroup
                aria-label="Frequency"
                value="weekly"
                onValueChange={onValueChange}
                options={[
                    { value: 'weekly', label: 'Weekly' },
                    { value: 'everyXDays', label: 'Every X days' },
                ]}
            />,
        );
        expect(screen.getByRole('radiogroup', { name: 'Frequency' })).toBeDefined();
        expect(screen.getByRole('radio', { name: 'Weekly' }).getAttribute('aria-checked')).toBe('true');
        await userEvent.click(screen.getByRole('radio', { name: 'Every X days' }));
        expect(onValueChange).toHaveBeenCalledWith('everyXDays');
    });

    it('disables a single option without disabling the group', async () => {
        const onValueChange = vi.fn();
        render(
            <RadioGroup
                aria-label="Frequency"
                value="weekly"
                onValueChange={onValueChange}
                options={[
                    { value: 'weekly', label: 'Weekly' },
                    { value: 'monthly', label: 'Monthly', disabled: true },
                ]}
            />,
        );
        const monthly = screen.getByRole('radio', { name: 'Monthly' });
        expect(monthly.getAttribute('aria-disabled')).toBe('true');
        await userEvent.click(monthly);
        expect(onValueChange).not.toHaveBeenCalled();
        expect(screen.getByRole('radio', { name: 'Weekly' }).hasAttribute('aria-disabled')).toBe(false);
    });
});
