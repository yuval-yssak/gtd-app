// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrequencyPicker } from '../components/routines/FrequencyPicker';

afterEach(cleanup);

// An ended calendar routine locks its schedule. The DS radios render as spans, which a native
// <fieldset disabled> does not reach — the lock has to be passed to them explicitly.
describe('FrequencyPicker disabled', () => {
    it('ignores a click on another frequency', () => {
        const onChange = vi.fn();
        render(<FrequencyPicker value="FREQ=DAILY" onChange={onChange} disabled />);

        fireEvent.click(screen.getByRole('radio', { name: 'Every year' }));

        expect(onChange).not.toHaveBeenCalled();
    });

    it('exposes every frequency radio as disabled', () => {
        render(<FrequencyPicker value="FREQ=DAILY" onChange={vi.fn()} disabled />);
        const radios = screen.getAllByRole('radio');
        expect(radios).toHaveLength(4);
        for (const radio of radios) {
            expect(radio.getAttribute('aria-disabled')).toBe('true');
        }
    });

    it('locks the floating/fixed anchor toggle too', () => {
        render(<FrequencyPicker value="FREQ=WEEKLY;BYDAY=MO" onChange={vi.fn()} disabled />);
        expect(screen.getByTestId('recurrenceAnchorFixed').hasAttribute('data-disabled')).toBe(true);
    });
});
