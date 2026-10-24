import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Button } from '../Button/Button';
import { Drawer } from './Drawer';

/** Opens on mount and really closes — for trying the swipe gestures (and the WebKit touch spike). */
function SwipeHarness({ side }: { side: 'start' | 'bottom' }) {
    const [isOpen, setIsOpen] = useState(true);
    return (
        <div style={{ padding: '1rem' }}>
            <Button variant="outline" onClick={() => setIsOpen(true)} data-testid="reopenDrawer">
                {isOpen ? 'Open' : 'Closed — reopen'}
            </Button>
            <Drawer open={isOpen} onClose={() => setIsOpen(false)} side={side} title={side === 'bottom' ? 'Move to…' : 'Menu'}>
                <div style={{ display: 'grid', padding: '0 0.5rem 1rem' }}>
                    {['Next Actions', 'Waiting For', 'Someday / Maybe', 'Calendar'].map((label) => (
                        <Button key={label} tone="neutral">
                            {label}
                        </Button>
                    ))}
                </div>
            </Drawer>
        </div>
    );
}

const meta = {
    title: 'Design System/Drawer',
    component: Drawer,
    args: { open: true, onClose: fn(), children: null },
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NavigationPanel: Story = {
    args: {
        'aria-label': 'Navigation',
        children: (
            <nav aria-label="Main" style={{ display: 'grid', gap: '0.25rem', padding: '1rem' }}>
                {['Inbox', 'Next Actions', 'Calendar', 'Waiting For', 'Someday', 'Tickler'].map((label) => (
                    <Button key={label} tone="neutral">
                        {label}
                    </Button>
                ))}
            </nav>
        ),
    },
};

export const SwipeToCloseNav: StoryObj = { render: () => <SwipeHarness side="start" /> };
export const SwipeToCloseSheet: StoryObj = { render: () => <SwipeHarness side="bottom" /> };

export const BottomSheet: Story = {
    args: {
        side: 'bottom',
        title: 'Move to…',
        children: (
            <div style={{ display: 'grid', padding: '0 0.5rem 1rem' }}>
                {['Next Actions', 'Waiting For', 'Someday / Maybe', 'Calendar', 'Trash'].map((label) => (
                    <Button key={label} tone="neutral">
                        {label}
                    </Button>
                ))}
            </div>
        ),
    },
};
