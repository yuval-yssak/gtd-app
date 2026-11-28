import type { Meta, StoryObj } from '@storybook/react';
import dayjs from 'dayjs';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import type { StoredClaudeAsk } from '../../types/MyDB';
import { AskClaudeSection } from './AskClaudeSection';
import { ASK_HISTORY_PREVIEW_COUNT } from './askClaudeLogic';
import type { AskClaudeState } from './useAskClaude';

/** The hook frozen in one state — the section renders from it alone. */
function makeState(overrides: Partial<AskClaudeState> = {}): AskClaudeState {
    return {
        prompt: '',
        setPrompt: fn(),
        isSending: false,
        isOnline: true,
        routineStatus: 'connected',
        error: null,
        startedSessionUrl: null,
        dismissStarted: fn(),
        submit: fn(),
        ...overrides,
    };
}

function makeAsk(id: string, minutesAgo: number, overrides: Partial<StoredClaudeAsk> = {}): StoredClaudeAsk {
    const ts = dayjs().subtract(minutesAgo, 'minute').toISOString();
    return {
        _id: id,
        userId: 'user-1',
        itemId: 'item-1',
        prompt: 'Keep this in the inbox, read the ticket and rewrite the title so it says what to implement.',
        sessionId: `session_${id}`,
        sessionUrl: `https://claude.ai/code/session_${id}`,
        createdTs: ts,
        updatedTs: ts,
        ...overrides,
    };
}

const WAITING = makeAsk('waiting', 2);
const COMPLETED = makeAsk('completed', 60, {
    result: { summary: 'Renamed to "Implement retry on transcription timeout"; left in the inbox.', outcome: 'completed', reportedTs: dayjs().toISOString() },
});
const NEEDS_INPUT = makeAsk('needs', 120, {
    prompt: 'Find the ticket and link it.',
    result: { summary: 'Two tickets match — which one did you mean?', outcome: 'needsInput', reportedTs: dayjs().toISOString() },
});

const meta = {
    title: 'Components/AskClaudeSection',
    component: AskClaudeSection,
    decorators: [RouterDecorator],
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    args: { state: makeState(), asks: [] },
} satisfies Meta<typeof AskClaudeSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Typing works in the story: the prompt lives in local state, everything else stays frozen. */
function TypingSection({ asks }: { asks: StoredClaudeAsk[] }) {
    const [prompt, setPrompt] = useState('');
    return <AskClaudeSection state={makeState({ prompt, setPrompt })} asks={asks} />;
}

export const Empty: Story = {};

export const Typed: Story = {
    render: () => <TypingSection asks={[]} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.type(within(await canvas.findByTestId('askClaudePrompt')).getByRole('textbox'), 'Draft a reply to the landlord');
        await waitFor(() => expect(canvas.getByTestId('askClaudeButton')).toBeEnabled());
    },
};

export const PromptNearLimit: Story = {
    args: { state: makeState({ prompt: 'Rewrite the notes as a checklist. '.repeat(110) }) },
};

export const Sending: Story = {
    args: { state: makeState({ prompt: 'Draft a reply to the landlord', isSending: true }) },
};

export const Offline: Story = {
    args: { state: makeState({ prompt: 'Draft a reply to the landlord', isOnline: false }) },
};

/** No Claude routine on the owner's account: no composer, a disabled button and the way to Settings. */
export const NotConnected: Story = {
    args: { state: makeState({ routineStatus: 'notConnected' }) },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(() => expect(canvas.getByTestId('askClaudeButton')).toBeDisabled());
        expect(canvas.queryByTestId('askClaudePrompt')).toBeNull();
        expect(canvas.getByTestId('askClaudeSettingsLink').getAttribute('href')).toMatch(/\/settings#claude-routine$/);
    },
};

export const NotConnectedWithHistory: Story = { args: { state: makeState({ routineStatus: 'notConnected' }), asks: [COMPLETED] } };

export const ReviewNotConnected: Story = { args: { isCollapsible: true, state: makeState({ routineStatus: 'notConnected' }), asks: [COMPLETED] } };

/** The status read had not answered (or failed) and the server then refused the ask. */
export const NotConnectedError: Story = {
    args: {
        state: makeState({ prompt: 'Draft a reply', error: { message: 'Connect a Claude routine in Settings to ask Claude from Done.', isSettingsFix: true } }),
    },
};

export const TimedOut: Story = {
    args: { state: makeState({ error: { message: 'Claude may already be starting — check the history below in a moment.', isSettingsFix: false } }), asks: [] },
};

export const Unreachable: Story = {
    args: { state: makeState({ prompt: 'Draft a reply', error: { message: "Claude couldn't be reached. Try again in a moment.", isSettingsFix: false } }) },
};

export const Started: Story = {
    args: { state: makeState({ startedSessionUrl: WAITING.sessionUrl }), asks: [WAITING] },
};

export const HistoryWaiting: Story = { args: { asks: [WAITING] } };

export const HistoryCompleted: Story = { args: { asks: [COMPLETED] } };

export const HistoryNeedsInput: Story = { args: { asks: [NEEDS_INPUT] } };

const MANY = [WAITING, COMPLETED, NEEDS_INPUT, makeAsk('older-1', 600), makeAsk('older-2', 6000)];

export const HistoryCollapsed: Story = {
    args: { asks: MANY },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(() => expect(canvas.getAllByTestId('askClaudeRow')).toHaveLength(ASK_HISTORY_PREVIEW_COUNT));
    },
};

export const HistoryExpanded: Story = {
    args: { asks: MANY },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(await canvas.findByTestId('askClaudeShowAll'));
        await waitFor(() => expect(canvas.getAllByTestId('askClaudeRow')).toHaveLength(MANY.length));
    },
};

export const ReviewCollapsed: Story = { args: { isCollapsible: true } };

export const ReviewCollapsedWithHistory: Story = { args: { isCollapsible: true, asks: [WAITING, COMPLETED] } };

export const ReviewExpanded: Story = {
    args: { isCollapsible: true, asks: [COMPLETED] },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(await canvas.findByTestId('askClaudeExpandButton'));
        await waitFor(() => expect(canvas.getByTestId('askClaudePrompt')).toBeVisible());
    },
};
