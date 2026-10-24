// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListRow, ListRowButton, ListRowText } from '../components/listRow/ListRow';

afterEach(cleanup);

/** A row whose button holds an inner control, the way RoutineIndicator sits inside a row. */
function renderRow(onActivate = vi.fn(), onKeyUp?: (e: KeyboardEvent<HTMLDivElement>) => void) {
    render(
        <ListRow actions={<button type="button">Edit</button>}>
            <ListRowButton onActivate={onActivate} onKeyUp={onKeyUp} data-testid="row">
                <ListRowText
                    primary={
                        <>
                            <span>Buy milk</span>
                            <button type="button">Routine</button>
                        </>
                    }
                    secondary="2 days ago"
                />
            </ListRowButton>
        </ListRow>,
    );
    return onActivate;
}

describe('ListRowButton', () => {
    it('is a focusable button named by its text', () => {
        renderRow();
        const row = screen.getByTestId('row');
        expect(row.getAttribute('role')).toBe('button');
        expect(row.tabIndex).toBe(0);
        expect(screen.getByRole('button', { name: /Buy milk/ })).toBe(row);
    });

    it('activates on click, passing the event (cmd/ctrl+click opens a new tab)', () => {
        const onActivate = renderRow();
        fireEvent.click(screen.getByTestId('row'), { metaKey: true });
        expect(onActivate).toHaveBeenCalledTimes(1);
        expect(onActivate.mock.calls[0]?.[0].metaKey).toBe(true);
    });

    // MUI ButtonBase parity: the Next Actions grab mode relies on exactly this split.
    it('activates on Enter keydown and on Space keyup, like a native button', () => {
        const onActivate = renderRow();
        const row = screen.getByTestId('row');
        fireEvent.keyDown(row, { key: 'Enter' });
        expect(onActivate).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(row, { key: ' ' });
        expect(onActivate).toHaveBeenCalledTimes(1);
        fireEvent.keyUp(row, { key: ' ' });
        expect(onActivate).toHaveBeenCalledTimes(2);
    });

    it('lets a keyup handler that claims Space (grab mode) suppress the activation', () => {
        const onActivate = renderRow(vi.fn(), (e) => {
            if (e.key === ' ') e.preventDefault();
        });
        fireEvent.keyUp(screen.getByTestId('row'), { key: ' ' });
        expect(onActivate).not.toHaveBeenCalled();
    });

    it('stops Space from scrolling the page on keydown', () => {
        renderRow();
        const isNotCancelled = fireEvent.keyDown(screen.getByTestId('row'), { key: ' ' });
        expect(isNotCancelled).toBe(false);
    });

    it('ignores keys aimed at a control nested inside the row', () => {
        const onActivate = renderRow();
        const inner = screen.getByRole('button', { name: 'Routine' });
        fireEvent.keyDown(inner, { key: 'Enter' });
        fireEvent.keyUp(inner, { key: ' ' });
        expect(onActivate).not.toHaveBeenCalled();
    });
});

describe('ListRow', () => {
    it('renders its actions beside the row button, not inside it', () => {
        renderRow();
        const edit = screen.getByRole('button', { name: 'Edit' });
        expect(screen.getByTestId('row').contains(edit)).toBe(false);
    });

    it('shows the secondary line under the primary one', () => {
        renderRow();
        expect(screen.getByText('2 days ago')).toBeDefined();
        expect(screen.getByTestId('listRowPrimary').textContent).toContain('Buy milk');
    });
});
