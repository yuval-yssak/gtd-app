// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

afterEach(cleanup);

describe('Checkbox', () => {
    it('is named by its label alone and described by its description', () => {
        render(<Checkbox checked={false} onCheckedChange={vi.fn()} label="Urgent" description="Shown first in Next Actions" />);
        expect(screen.getByRole('checkbox', { name: 'Urgent', description: 'Shown first in Next Actions' })).toBeDefined();
    });

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

    it('reports a mixed state when indeterminate', () => {
        render(<Checkbox checked onCheckedChange={vi.fn()} indeterminate aria-label="All calendars" />);
        expect(screen.getByRole('checkbox', { name: 'All calendars' }).getAttribute('aria-checked')).toBe('mixed');
    });
});
