// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkbox } from '../Checkbox/Checkbox';
import { RadioGroup } from '../RadioGroup/RadioGroup';
import { Switch } from './Switch';

afterEach(cleanup);

describe('Switch', () => {
    it('is a switch named by its label and toggles when the label is clicked', async () => {
        const onCheckedChange = vi.fn();
        render(<Switch checked={false} onCheckedChange={onCheckedChange} label="Show briefs" />);
        const toggle = screen.getByRole('switch', { name: 'Show briefs' });
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        await userEvent.click(screen.getByText('Show briefs'));
        expect(onCheckedChange).toHaveBeenCalledWith(true);
    });

    it('can be named by aria-label alone', () => {
        render(<Switch checked onCheckedChange={vi.fn()} aria-label="Visible" />);
        expect(screen.getByRole('switch', { name: 'Visible' }).getAttribute('aria-checked')).toBe('true');
    });
});

describe('Checkbox', () => {
    it('is a checkbox named by its label (e2e: getByRole checkbox { name: "Sync Primary" })', async () => {
        function Harness() {
            const [isChecked, setIsChecked] = useState(false);
            return <Checkbox checked={isChecked} onCheckedChange={setIsChecked} label="Sync Primary" />;
        }
        render(<Harness />);
        const box = screen.getByRole('checkbox', { name: 'Sync Primary' });
        await userEvent.click(box);
        expect(box.getAttribute('aria-checked')).toBe('true');
    });

    it('can be named by aria-label without a visible label', () => {
        render(<Checkbox checked={false} onCheckedChange={vi.fn()} aria-label="Sync Secondary" />);
        expect(screen.getByRole('checkbox', { name: 'Sync Secondary' })).toBeDefined();
    });
});

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
});
