import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Meta, StoryObj } from '@storybook/react';
import { AppErrorBoundary } from './AppErrorBoundary';

function Thrower({ message }: { message: string }) {
    // Throwing during render is exactly what we want the boundary to catch in the story.
    // Wrapped in a function so React's component return-type inference stays as ReactNode rather
    // than collapsing to `void`, which the JSX compiler rejects when used as <Thrower />.
    const explode = () => {
        throw new Error(message);
    };
    return <>{explode()}</>;
}

function HappyChild() {
    return (
        <Box sx={{ p: 2 }}>
            <Typography>Happy child — boundary stays invisible.</Typography>
        </Box>
    );
}

const meta = {
    title: 'Components/AppErrorBoundary',
    component: AppErrorBoundary,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
} satisfies Meta<typeof AppErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Page-mode boundary catching a thrown render error — full-page Reload action. */
export const PageError: Story = {
    args: { mode: 'page', children: <Thrower message="Boot failed: cannot reach IndexedDB" /> },
};

/** Inline-mode boundary — fits inside a panel; offers a Retry that resets local state. */
export const InlineError: Story = {
    args: { mode: 'inline', children: <Thrower message="Failed to load calendar options" /> },
};

/** Custom fallback action — caller-supplied button, e.g. for closing the surrounding dialog. */
export const CustomAction: Story = {
    args: {
        mode: 'inline',
        title: 'Could not load',
        fallbackAction: (reset) => (
            <button type="button" onClick={reset}>
                Dismiss
            </button>
        ),
        children: <Thrower message="Server returned 500" />,
    },
};

/** No error — boundary is transparent and just renders the child. */
export const NoError: Story = {
    args: { mode: 'page', children: <HappyChild /> },
};
