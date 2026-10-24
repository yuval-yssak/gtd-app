// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToggleGroup } from '../ToggleGroup/ToggleGroup';
import { Tabs } from './Tabs';

afterEach(cleanup);

describe('Tabs', () => {
    it('reports the clicked tab and marks it selected', async () => {
        function Harness() {
            const [tab, setTab] = useState<'nextAction' | 'calendar'>('nextAction');
            return (
                <Tabs
                    aria-label="Routine type"
                    value={tab}
                    onValueChange={setTab}
                    tabs={[
                        { value: 'nextAction', label: 'Next Action' },
                        { value: 'calendar', label: 'Calendar' },
                    ]}
                />
            );
        }
        render(<Harness />);
        await userEvent.click(screen.getByRole('tab', { name: 'Calendar' }));
        expect(screen.getByRole('tab', { name: 'Calendar' }).getAttribute('aria-selected')).toBe('true');
    });

    it('moves between tabs with the arrow keys', async () => {
        const onValueChange = vi.fn();
        render(
            <Tabs
                aria-label="Notes"
                value={0}
                onValueChange={onValueChange}
                tabs={[
                    { value: 0, label: 'Edit' },
                    { value: 1, label: 'Preview' },
                ]}
            />,
        );
        screen.getByRole('tab', { name: 'Edit' }).focus();
        await userEvent.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Preview' }));
    });
});

describe('ToggleGroup', () => {
    const OPTIONS = [
        { value: 'never', label: 'Never' },
        { value: 'after', label: 'After' },
    ] as const;

    it('reports the pressed segment', async () => {
        const onValueChange = vi.fn();
        render(<ToggleGroup aria-label="Ends" value="never" onValueChange={onValueChange} options={OPTIONS} />);
        await userEvent.click(screen.getByRole('button', { name: 'After' }));
        expect(onValueChange).toHaveBeenCalledWith('after');
    });

    it('keeps the current choice when its own segment is pressed again (never empty)', async () => {
        const onValueChange = vi.fn();
        render(<ToggleGroup aria-label="Ends" value="never" onValueChange={onValueChange} options={OPTIONS} />);
        await userEvent.click(screen.getByRole('button', { name: 'Never' }));
        expect(onValueChange).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Never' }).getAttribute('aria-pressed')).toBe('true');
    });
});
