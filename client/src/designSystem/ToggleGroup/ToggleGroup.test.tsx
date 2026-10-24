// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToggleGroup } from './ToggleGroup';

afterEach(cleanup);

const ENERGY = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
] as const;

describe('ToggleGroup', () => {
    it('marks the current value pressed and reports a new pick', async () => {
        const onValueChange = vi.fn();
        render(<ToggleGroup aria-label="Energy" value="low" onValueChange={onValueChange} options={ENERGY} />);
        expect(screen.getByRole('button', { name: 'Low' }).getAttribute('aria-pressed')).toBe('true');
        await userEvent.click(screen.getByRole('button', { name: 'High' }));
        expect(onValueChange).toHaveBeenCalledWith('high');
    });

    it('keeps the choice when the active segment is pressed again (exactly one is always pressed)', async () => {
        const onValueChange = vi.fn();
        render(<ToggleGroup aria-label="Energy" value="low" onValueChange={onValueChange} options={ENERGY} />);
        await userEvent.click(screen.getByRole('button', { name: 'Low' }));
        expect(onValueChange).not.toHaveBeenCalled();
    });

    it('with allowDeselect, pressing the active segment clears the choice to empty', async () => {
        const onValueChange = vi.fn();
        render(<ToggleGroup aria-label="Energy" allowDeselect value="low" onValueChange={onValueChange} options={ENERGY} />);
        await userEvent.click(screen.getByRole('button', { name: 'Low' }));
        expect(onValueChange).toHaveBeenCalledWith('');
    });

    it('with allowDeselect, an empty value presses nothing', () => {
        render(<ToggleGroup aria-label="Energy" allowDeselect value="" onValueChange={() => {}} options={ENERGY} />);
        expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
    });
});
