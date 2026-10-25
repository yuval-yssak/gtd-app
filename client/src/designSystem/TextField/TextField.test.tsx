// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextField } from './TextField';

afterEach(cleanup);

function ControlledTitle({ onChange = vi.fn(), multiline = false }) {
    const [title, setTitle] = useState('');
    return (
        <TextField
            label="Title"
            value={title}
            multiline={multiline}
            onChange={(event) => {
                setTitle(event.target.value);
                onChange(event.target.value);
            }}
        />
    );
}

describe('TextField', () => {
    it('labels its input so getByRole("textbox", { name }) finds it', () => {
        render(<TextField label="Title" />);
        expect(screen.getByRole('textbox', { name: 'Title' }).tagName).toBe('INPUT');
    });

    it('labels a multiline field’s textarea the same way', () => {
        render(<TextField label="Notes" multiline minRows={3} />);
        const notes = screen.getByRole('textbox', { name: 'Notes' });
        expect(notes.tagName).toBe('TEXTAREA');
        expect(notes.getAttribute('rows')).toBe('3');
    });

    it('fires onChange with the native event on every keystroke', async () => {
        const onChange = vi.fn();
        render(<ControlledTitle onChange={onChange} />);
        await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Call');
        expect(onChange).toHaveBeenLastCalledWith('Call');
    });

    it('keeps a required asterisk out of the accessible name', () => {
        render(<TextField label="Name" required />);
        expect(screen.getByRole('textbox', { name: 'Name' }).hasAttribute('required')).toBe(true);
    });

    it('describes the control with its helper text', () => {
        render(<TextField label="Email" helperText="We never share it" />);
        const input = screen.getByRole('textbox', { name: 'Email' });
        expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('We never share it').id);
    });

    it('marks the control invalid when error is set', () => {
        render(<TextField label="Email" error helperText="Invalid email" />);
        expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('aria-invalid')).toBe('true');
    });

    it('forwards inputProps and inputRef to the control itself', () => {
        const ref = createRef<HTMLInputElement>();
        render(<TextField label="Search" inputProps={{ 'data-testid': 'searchInput', maxLength: 5 }} inputRef={ref} />);
        const input = screen.getByTestId('searchInput');
        expect(input.getAttribute('maxlength')).toBe('5');
        expect(ref.current).toBe(input);
    });

    // The textarea itself has no border (the shell draws it), so the only slack is one pixel for
    // scrollHeight's integer rounding of a fractional line box.
    it('sizes a multiline field to its content plus one pixel of rounding slack', async () => {
        render(<TextField label="Notes" multiline />);
        const notes = screen.getByRole('textbox', { name: 'Notes' });
        Object.defineProperty(notes, 'scrollHeight', { configurable: true, value: 48 });
        await userEvent.type(notes, 'a');
        expect(notes.style.blockSize).toBe('49px');
    });

    it('puts data-testid on the field root, as MUI did', () => {
        render(<TextField label="Title" data-testid="titleField" />);
        expect(screen.getByTestId('titleField').contains(screen.getByRole('textbox'))).toBe(true);
    });
});
