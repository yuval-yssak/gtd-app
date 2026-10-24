// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chip } from './Chip';

afterEach(cleanup);

describe('Chip', () => {
    it('is plain text when not clickable', () => {
        render(<Chip label="default" data-testid="defaultChip" />);
        expect(screen.getByTestId('defaultChip').tagName).toBe('SPAN');
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('is itself the button when clickable, so its test id targets the pressable element', async () => {
        const onClick = vi.fn();
        render(<Chip label="Phone" onClick={onClick} data-testid="editorWorkContextChip" />);
        const chip = screen.getByTestId('editorWorkContextChip');
        expect(chip).toBe(screen.getByRole('button', { name: 'Phone' }));
        await userEvent.click(chip);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('exposes a toggle chip’s state as aria-pressed and data-selected', () => {
        render(
            <>
                <Chip label="Phone" onClick={vi.fn()} selected />
                <Chip label="Home" onClick={vi.fn()} selected={false} />
            </>,
        );
        const phone = screen.getByRole('button', { name: 'Phone' });
        const home = screen.getByRole('button', { name: 'Home' });
        expect(phone.getAttribute('aria-pressed')).toBe('true');
        expect(phone.hasAttribute('data-selected')).toBe(true);
        expect(home.getAttribute('aria-pressed')).toBe('false');
        expect(home.hasAttribute('data-selected')).toBe(false);
    });

    it('offers a named remove button with onDelete', async () => {
        const onDelete = vi.fn();
        render(<Chip label="Alice" onDelete={onDelete} />);
        await userEvent.click(screen.getByRole('button', { name: 'Remove Alice' }));
        expect(onDelete).toHaveBeenCalledTimes(1);
    });
});
