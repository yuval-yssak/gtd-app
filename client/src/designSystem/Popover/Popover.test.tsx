// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen } from '../../lib/keyboardRegionDom';
import { Button } from '../Button/Button';
import { Popover } from './Popover';

afterEach(cleanup);

describe('Popover', () => {
    it('hangs off an anchor element, is an open modal, and closes on Escape', async () => {
        const onClose = vi.fn();
        function Harness() {
            const [anchor, setAnchor] = useState<HTMLElement | null>(null);
            return (
                <>
                    <Button onClick={(event) => setAnchor(event.currentTarget)}>Pick date</Button>
                    <Popover open={anchor !== null} anchor={anchor} onClose={onClose} aria-label="Date picker">
                        <button type="button">Today</button>
                    </Popover>
                </>
            );
        }
        render(<Harness />);
        await userEvent.click(screen.getByRole('button', { name: 'Pick date' }));
        expect(await screen.findByRole('button', { name: 'Today' })).toBeDefined();
        expect(isModalOpen()).toBe(true);
        await userEvent.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
