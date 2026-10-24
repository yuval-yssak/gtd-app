import type { Meta, StoryObj } from '@storybook/react';
import { Repeat } from 'lucide-react';
import { fn } from 'storybook/test';
import { Chip } from './Chip';

const meta = {
    title: 'Design System/Chip',
    component: Chip,
    args: { label: 'Phone' },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Soft: Story = {};
export const Outline: Story = { args: { variant: 'outline' } };
export const Tones: Story = {
    render: () => (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {(['neutral', 'accent', 'success', 'warning', 'error', 'info'] as const).map((tone) => (
                <Chip key={tone} tone={tone} label={tone} />
            ))}
            {(['neutral', 'accent', 'success', 'warning', 'error', 'info'] as const).map((tone) => (
                <Chip key={`${tone}-outline`} tone={tone} variant="outline" label={tone} />
            ))}
        </div>
    ),
};
/** Toggled on: accent for neutral/accent, solid in the status tone otherwise (the editor's Done / Trash chips). */
export const SelectedTones: Story = {
    render: () => (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {(['neutral', 'accent', 'success', 'warning', 'error', 'info'] as const).map((tone) => (
                <Chip key={tone} tone={tone} variant="outline" label={tone} selected onClick={fn()} />
            ))}
        </div>
    ),
};
export const WithIcon: Story = { args: { label: 'Routine', icon: <Repeat />, variant: 'outline' } };
export const Clickable: Story = { args: { variant: 'outline', onClick: fn() } };
export const ToggledOn: Story = { args: { onClick: fn(), selected: true } };
export const ToggledOff: Story = { args: { variant: 'outline', onClick: fn(), selected: false } };
export const Deletable: Story = { args: { label: 'Alice', onDelete: fn() } };
export const Medium: Story = { args: { size: 'md' } };
