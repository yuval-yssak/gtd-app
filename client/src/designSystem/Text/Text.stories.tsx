import type { Meta, StoryObj } from '@storybook/react';
import { Text, type TextVariant } from './Text';

const meta = {
    title: 'Design System/Text',
    component: Text,
    args: { children: 'Call the dentist about the crown' },
} satisfies Meta<typeof Text>;

export default meta;
type Story = StoryObj<typeof meta>;

const VARIANTS: TextVariant[] = ['display', 'headline', 'title', 'titleSm', 'subtitle', 'subtitleSm', 'body', 'bodySm', 'caption', 'overline'];

export const Ramp: Story = {
    render: (args) => (
        <div>
            {VARIANTS.map((variant) => (
                <Text key={variant} {...args} variant={variant}>
                    {variant} — {args.children}
                </Text>
            ))}
        </div>
    ),
};

export const Secondary: Story = { args: { variant: 'bodySm', tone: 'secondary' } };
export const ErrorTone: Story = { args: { variant: 'caption', tone: 'error', children: 'Could not save' } };
export const DisabledTone: Story = { args: { variant: 'bodySm', tone: 'disabled', children: 'Not connected' } };
