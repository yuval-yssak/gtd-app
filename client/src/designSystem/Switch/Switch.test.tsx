// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

    it('is named by its label alone; the description describes it instead of running into the name', () => {
        render(<Switch checked={false} onCheckedChange={vi.fn()} label="Show briefs" description="In the weekly review" />);
        // A string name matches the whole computed name, so a run-on "Show briefsIn the…" fails here.
        expect(screen.getByRole('switch', { name: 'Show briefs', description: 'In the weekly review' })).toBeDefined();
    });

    it('puts controlProps on the focusable switch itself (a keyboard region walks it by arrows)', () => {
        render(
            <Switch checked={false} onCheckedChange={vi.fn()} label="Show tags" controlProps={{ tabIndex: -1, 'data-roving-item': '' }} data-testid="toggle" />,
        );
        const control = screen.getByRole('switch', { name: 'Show tags' });
        expect(control.tabIndex).toBe(-1);
        expect(control.hasAttribute('data-roving-item')).toBe(true);
    });

    it('can be named by aria-label alone', () => {
        render(<Switch checked onCheckedChange={vi.fn()} aria-label="Visible" />);
        expect(screen.getByRole('switch', { name: 'Visible' }).getAttribute('aria-checked')).toBe('true');
    });
});
