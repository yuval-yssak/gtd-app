import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ClaudeRoutineSectionView } from './ClaudeRoutineSection';
import { CLAUDE_ROUTINE_LOAD_ERROR } from './claudeRoutineSectionLogic';
import type { ClaudeRoutineConnectionState } from './useClaudeRoutineConnection';

/** The connection hook frozen in one state. */
function makeState(overrides: Partial<ClaudeRoutineConnectionState> = {}): ClaudeRoutineConnectionState {
    return {
        connection: { connected: false },
        loadError: null,
        actionError: null,
        isPending: false,
        isOnline: true,
        isReplacing: false,
        startReplacing: fn(),
        cancelReplacing: fn(),
        retryLoad: fn(),
        save: fn().mockResolvedValue(true),
        disconnect: fn(),
        ...overrides,
    };
}

const CONNECTED = { connected: true, claudeRoutineId: 'trig_01Hq8xYv2PaT', tokenHint: '1a2b', updatedTs: '2026-11-21T10:00:00.000Z' };

const meta = {
    title: 'Settings/ClaudeRoutineSection',
    component: ClaudeRoutineSectionView,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    args: { state: makeState() },
} satisfies Meta<typeof ClaudeRoutineSectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { state: makeState({ connection: null }) } };

export const LoadingOffline: Story = { args: { state: makeState({ connection: null, isOnline: false }) } };

export const LoadFailed: Story = { args: { state: makeState({ connection: null, loadError: CLAUDE_ROUTINE_LOAD_ERROR }) } };

export const NotConnected: Story = {};

export const NotConnectedOffline: Story = { args: { state: makeState({ isOnline: false }) } };

export const InvalidInput: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.type(within(await canvas.findByTestId('claudeRoutineIdInput')).getByRole('textbox'), 'routine-1');
        await userEvent.click(canvas.getByTestId('claudeRoutineSaveButton'));
        await waitFor(() => expect(canvas.getByTestId('claudeRoutineValidationError')).toBeVisible());
    },
};

export const Connected: Story = { args: { state: makeState({ connection: CONNECTED }) } };

export const ConnectedOffline: Story = { args: { state: makeState({ connection: CONNECTED, isOnline: false }) } };

export const Replacing: Story = {
    args: { state: makeState({ connection: CONNECTED, isReplacing: true }) },
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(within(canvasElement).getByTestId('claudeRoutineCancelButton')).toBeVisible());
    },
};

export const Saving: Story = { args: { state: makeState({ isPending: true }) } };

export const ActionFailed: Story = {
    args: { state: makeState({ connection: CONNECTED, actionError: "Couldn't reach Done's server. Check the connection and try again." }) },
};
