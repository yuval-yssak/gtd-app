import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { Badge } from '../Badge/Badge';
import { Button } from '../Button/Button';
import { Card } from '../Card/Card';
import { ProgressBar } from '../ProgressBar/ProgressBar';
import { Separator } from '../Separator/Separator';
import { Skeleton } from '../Skeleton/Skeleton';
import { Spinner } from '../Spinner/Spinner';
import { StepIndicator } from '../StepIndicator/StepIndicator';
import { Callout } from './Callout';

const meta = {
    title: 'Design System/Feedback',
    component: Callout,
    args: { children: 'Reconnect Google Calendar to keep events in sync.' },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof Callout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CalloutInfo: Story = {};
export const CalloutWarningWithAction: Story = {
    args: { tone: 'warning', title: 'Sync is broken', action: <Button size="sm">Re-login</Button>, onClose: fn() },
};
export const CalloutError: Story = { args: { tone: 'error', title: 'Something went wrong', children: 'The page could not load.' } };
export const CalloutSuccessOutline: Story = { args: { tone: 'success', variant: 'outline', children: 'All caught up.' } };

export const Surfaces: StoryObj = {
    render: () => (
        <div style={{ display: 'grid', gap: '1rem', maxInlineSize: '28rem' }}>
            <Card>Outline card with the default padding.</Card>
            <Card variant="sunken" padding="sm">
                Sunken card.
            </Card>
            <Separator />
            <Badge count={7}>
                <Button variant="outline">Inbox</Button>
            </Badge>
            <Badge count={120} tone="error" />
        </div>
    ),
};

export const Loading: StoryObj = {
    render: () => (
        <div style={{ display: 'grid', gap: '1rem', maxInlineSize: '28rem' }}>
            <Spinner />
            <Spinner size={16} />
            <ProgressBar value={null} aria-label="Syncing" />
            <ProgressBar value={60} aria-label="Uploading" />
            <div>
                <Skeleton style={{ inlineSize: '60%' }} />
                <Skeleton />
                <Skeleton shape="rect" style={{ blockSize: '4rem' }} />
            </div>
        </div>
    ),
};

export const Steps: StoryObj = {
    render: () => (
        <StepIndicator
            aria-label="Weekly review"
            activeIndex={2}
            steps={['Collect', 'Inbox', 'Calendar', 'Waiting For', 'Projects'].map((label) => ({ key: label, label }))}
            onStepSelected={fn()}
        />
    ),
};
