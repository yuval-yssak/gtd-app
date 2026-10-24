import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb } from '../../test-utils/storybookMocks';
import type { StoredAccount } from '../../types/MyDB';
import { AccountDataSection } from './AccountDataSection';
import { ConnectMismatchError, ScopeMissingError } from './CalendarIntegrations';
import { CalendarIntegrationsSkeleton } from './CalendarIntegrationsSkeleton';
import { ConnectClaude } from './ConnectClaude';

const sampleAccount: StoredAccount = { id: 'user-1', email: 'me@example.com', name: 'Me', image: null, provider: 'google', addedAt: 0 };

const meta = {
    title: 'Settings/Sections',
    component: ConnectClaude,
    parameters: { layout: 'padded' },
} satisfies Meta<typeof ConnectClaude>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The hosted-MCP connection guide with its copyable connector URL. */
export const ConnectClaudeGuide: Story = {};

/** The calendar section's Suspense fallback, sized like the resolved list. */
export const CalendarLoading: StoryObj = { render: () => <CalendarIntegrationsSkeleton /> };

/** The post-OAuth banner for a partial grant (scopes unticked on Google's consent screen). */
export const CalendarScopeMissing: StoryObj = { render: () => <ScopeMissingError onDismiss={fn()} /> };

/** The post-OAuth banner for an authorized Google account that didn't match the selected one. */
export const CalendarAccountMismatch: StoryObj = { render: () => <ConnectMismatchError onDismiss={fn()} /> };

/** Download my data / Delete my account. */
export const YourData: StoryObj = {
    decorators: [editorProvidersDecorator()],
    render: () => <AccountDataSection db={mockDb} account={sampleAccount} />,
};
