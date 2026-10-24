import type { Meta, StoryObj } from '@storybook/react';
import { Search } from 'lucide-react';
import { userEvent, within } from 'storybook/test';
import { TextField } from './TextField';

const meta = {
    title: 'Design System/TextField',
    component: TextField,
    args: { label: 'Title', placeholder: 'What needs doing?' },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Filled: Story = { args: { defaultValue: 'Call the dentist' } };
export const Required: Story = { args: { required: true } };
export const WithHelperText: Story = { args: { helperText: 'Shown in the weekly review' } };
export const ErrorState: Story = { args: { label: 'Email', defaultValue: 'not-an-email', error: true, helperText: 'Enter a valid email' } };
export const Disabled: Story = { args: { defaultValue: 'Read only', disabled: true } };
export const MediumSize: Story = { args: { size: 'md' } };
export const FullWidth: Story = { args: { fullWidth: true } };
export const WithAdornment: Story = {
    args: { label: undefined, inputProps: { 'aria-label': 'Search' }, placeholder: 'Search', startAdornment: <Search size={18} /> },
};
export const Multiline: Story = { args: { label: 'Notes', multiline: true, minRows: 3, fullWidth: true } };
export const MultilineGrown: Story = {
    args: {
        label: 'Notes',
        multiline: true,
        minRows: 2,
        maxRows: 6,
        fullWidth: true,
        defaultValue: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8',
    },
};

export const Focused: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(within(canvasElement).getByRole('textbox'));
    },
};
