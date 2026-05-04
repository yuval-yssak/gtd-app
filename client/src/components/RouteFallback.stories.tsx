import type { Meta, StoryObj } from '@storybook/react';
import { RouteFallback } from './RouteFallback';

const meta = {
    title: 'Components/RouteFallback',
    component: RouteFallback,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
} satisfies Meta<typeof RouteFallback>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default fallback used by the route-level Suspense boundary. */
export const Default: Story = {};

/** Boot-time fallback — same visual, distinct testid for e2e specs. */
export const BootSplash: Story = {
    args: { testId: 'bootFallback' },
};
