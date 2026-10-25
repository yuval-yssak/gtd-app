import type { Meta, StoryObj } from '@storybook/react';
import { GoToHint } from './GoToHint';

const meta = {
    title: 'Components/GoToHint',
    component: GoToHint,
    args: { isOpen: true },
} satisfies Meta<typeof GoToHint>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A `g` jump is pending — every target letter and where it goes. */
export const Visible: Story = {};
