import type { Meta, StoryObj } from '@storybook/react';
import { mockDb } from '../test-utils/storybookMocks';
import { AccountSwitcher } from './AccountSwitcher';

/**
 * AccountSwitcher uses the `useAccounts(db)` hook which makes HTTP calls to
 * the Better Auth API. In Storybook, those calls fail silently (the hook
 * catches all errors and initialises from empty state), so the initial render
 * shows an empty avatar placeholder. This correctly exercises the loading/
 * unauthenticated visual state of the component.
 */
const meta = {
    title: 'Components/AccountSwitcher',
    component: AccountSwitcher,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    args: { db: mockDb },
} satisfies Meta<typeof AccountSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * No accounts loaded yet — the avatar shows a "?" placeholder since the
 * Better Auth API is unreachable in Storybook.
 */
export const EmptyAccounts: Story = {};
