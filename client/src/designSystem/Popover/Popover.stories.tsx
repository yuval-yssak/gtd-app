import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { userEvent, within } from 'storybook/test';
import { Button } from '../Button/Button';
import { Popover } from './Popover';

function DatePickerDemo({ side = 'bottom' }: { side?: 'bottom' | 'top' }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    return (
        <>
            <Button variant="outline" onClick={(event) => setAnchor(event.currentTarget)}>
                Pick a date
            </Button>
            <Popover open={anchor !== null} anchor={anchor} side={side} onClose={() => setAnchor(null)} aria-label="Date picker">
                <div style={{ display: 'grid', gap: '0.5rem', padding: '1rem', minInlineSize: '16rem' }}>
                    <Button onClick={() => setAnchor(null)}>Today</Button>
                    <Button onClick={() => setAnchor(null)}>Tomorrow</Button>
                    <Button onClick={() => setAnchor(null)}>Next week</Button>
                </div>
            </Popover>
        </>
    );
}

const meta = {
    title: 'Design System/Popover',
    component: DatePickerDemo,
} satisfies Meta<typeof DatePickerDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

const openPopover: Story['play'] = async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Pick a date' }));
    await within(document.body).findByRole('button', { name: 'Today' });
};

export const Closed: Story = {};
export const OpenBelow: Story = { play: openPopover };
export const OpenAbove: Story = { args: { side: 'top' }, play: openPopover };
