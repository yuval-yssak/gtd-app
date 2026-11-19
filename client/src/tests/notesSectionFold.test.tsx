// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NotesSection } from '../components/itemEditor/NotesSection';

afterEach(cleanup);

const noop = () => {};

describe('NotesSection — folding never interrupts the user', () => {
    it('a brief arriving while the notes editor is open does not fold it away', () => {
        const { rerender } = render(<NotesSection notes="Draft" onNotesChange={noop} collapsible={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
        // The brief lands (generate-brief or the sweep): the host now asks for the fold.
        rerender(<NotesSection notes="Draft" onNotesChange={noop} collapsible />);
        expect(screen.getByRole('button', { name: 'Done editing notes' })).toBeTruthy();
        expect(screen.queryByTestId('showNotesButton')).toBeNull();
    });

    it('a brief arriving after typing into the resting empty editor does not fold it away', () => {
        const { rerender } = render(<NotesSection notes="" onNotesChange={noop} collapsible={false} />);
        // Empty notes open straight into the editor, so that editor is already the user's writing
        // surface: whatever they type there, a brief that follows must not take it away.
        rerender(<NotesSection notes="typed" onNotesChange={noop} collapsible={false} />);
        rerender(<NotesSection notes="typed" onNotesChange={noop} collapsible />);
        expect(screen.queryByTestId('showNotesButton')).toBeNull();
    });

    it('a brief already on show at open still folds untouched notes', () => {
        render(<NotesSection notes="Long notes" onNotesChange={noop} collapsible />);
        expect(screen.getByTestId('showNotesButton')).toBeTruthy();
    });
});

describe('NotesSection — empty notes resting on the header', () => {
    it('the editor opened from the pencil can be left while still empty, back to the header', () => {
        render(<NotesSection notes="" onNotesChange={noop} emptyRestingState="header" />);
        expect(screen.getByText('No notes')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
        const done = screen.getByRole('button', { name: 'Done editing notes' });
        expect(done.matches(':disabled')).toBe(false);
        fireEvent.click(done);
        expect(screen.getByText('No notes')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Done editing notes' })).toBeNull();
    });
});
