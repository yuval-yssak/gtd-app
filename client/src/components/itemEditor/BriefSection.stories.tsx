import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import type { BriefState } from '../../lib/briefSource';
import { BriefSection } from './BriefSection';

const meta = {
    title: 'Components/BriefSection',
    component: BriefSection,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    // Required by StoryObj type even when `render` overrides the component entirely.
    args: { value: '', state: 'none', onChange: fn(), onCommit: fn() },
} satisfies Meta<typeof BriefSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledBriefSection({ initial, state, variant }: { initial: string; state: BriefState; variant?: 'field' | 'line' }) {
    const [value, setValue] = useState(initial);
    return <BriefSection value={value} state={state} onChange={setValue} onCommit={fn()} {...(variant ? { variant } : {})} />;
}

/** No brief yet — the empty field with its placeholder and no clear button. */
export const Empty: Story = {
    render: () => <ControlledBriefSection initial="" state="none" />,
};

/** A brief whose source hash still matches the item's title + notes. */
export const Fresh: Story = {
    render: () => <ControlledBriefSection initial="Renew the passport before the June trip — form is half filled." state="fresh" />,
};

/** A user-authored brief whose notes moved on since it was written — the muted marker shows. */
export const PinnedStale: Story = {
    render: () => <ControlledBriefSection initial="Renew the passport before the June trip — form is half filled." state="pinnedStale" />,
};

/** Review presentation: the brief reads as a plain line; clicking it opens the field in place. */
export const ReviewLine: Story = {
    render: () => <ControlledBriefSection initial="Renew the passport before the June trip — form is half filled." state="fresh" variant="line" />,
};

/** Review presentation with the stale marker under the line. */
export const ReviewLinePinnedStale: Story = {
    render: () => <ControlledBriefSection initial="Renew the passport before the June trip — form is half filled." state="pinnedStale" variant="line" />,
};
