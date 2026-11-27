import type { Meta, StoryObj } from '@storybook/react';
import { useRef } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from '../../designSystem';
import { DiscardEditsButton } from './DiscardEditsButton';

/** Discard beside the host's primary action, as a review card renders them; the primary takes focus after a discard. */
function WithPrimary({ onDiscard, disabled }: { onDiscard: () => void; disabled?: boolean }) {
    const primaryRef = useRef<HTMLButtonElement>(null);
    return (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
            <DiscardEditsButton onDiscard={onDiscard} focusAfter={primaryRef} disabled={disabled} testId="discard" />
            <Button ref={primaryRef} variant="solid" data-testid="primary">
                Save &amp; next
            </Button>
        </div>
    );
}

const meta = {
    title: 'Weekly Review/DiscardEditsButton',
    component: WithPrimary,
    args: { onDiscard: fn() },
} satisfies Meta<typeof WithPrimary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shown beside Save while a review card holds unsaved edits; a click drops them and hands focus to the primary. */
export const Default: Story = {
    play: async ({ args, canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByTestId('discard'));
        await expect(args.onDiscard).toHaveBeenCalledOnce();
        await expect(canvas.getByTestId('primary')).toHaveFocus();
    },
};

/** Locked while a save is in flight. */
export const Disabled: Story = { args: { disabled: true } };
