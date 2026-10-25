import type { Meta, StoryObj } from '@storybook/react';
import { expect, waitFor, within } from 'storybook/test';
import { closeShortcutsDialog, openShortcutsDialog } from '../lib/shortcutsDialogStore';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';

const meta = {
    title: 'Components/KeyboardShortcutsDialog',
    component: KeyboardShortcutsDialog,
} satisfies Meta<typeof KeyboardShortcutsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opened by `?` (or a page's keyboard button) — the app-wide legend, grouped by where each key works. */
export const Open: Story = {
    beforeEach: () => {
        openShortcutsDialog();
        return closeShortcutsDialog;
    },
    play: async () => {
        await waitFor(() => expect(within(document.body).getByTestId('keyboardShortcutsDialog')).toBeVisible());
    },
};
