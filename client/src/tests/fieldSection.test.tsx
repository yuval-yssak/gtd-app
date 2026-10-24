// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FieldSection } from '../components/clarify/FieldSection';

afterEach(cleanup);

describe('FieldSection', () => {
    it('names its group with the caption', () => {
        render(
            <FieldSection label="Ends">
                <input aria-label="Occurrences" />
            </FieldSection>,
        );
        expect(screen.getByRole('group', { name: 'Ends' })).toBeTruthy();
    });

    // A real lock, not a dimmed look: the native fieldset disables every native control inside it,
    // keyboard included (pointer-events only stops the mouse).
    it('disables the native controls inside it when disabled', () => {
        render(
            <FieldSection label="Ends" disabled>
                <input aria-label="Occurrences" />
            </FieldSection>,
        );
        expect(screen.getByRole('textbox', { name: 'Occurrences' }).matches(':disabled')).toBe(true);
    });
});
