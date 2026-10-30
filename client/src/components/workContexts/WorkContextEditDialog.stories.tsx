import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, sampleWorkContexts } from '../../test-utils/storybookMocks';
import { WorkContextEditDialog } from './WorkContextEditDialog';

const [sampleContext] = sampleWorkContexts;
if (!sampleContext) {
    throw new Error('storybookMocks must provide at least one sample work context');
}

const meta = {
    title: 'Work Contexts/WorkContextEditDialog',
    component: WorkContextEditDialog,
    decorators: [editorProvidersDecorator({ workContexts: sampleWorkContexts, allWorkContexts: sampleWorkContexts })],
    args: { db: mockDb, workContext: sampleContext, onClose: fn() },
} satisfies Meta<typeof WorkContextEditDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rename an existing context — autosaving, Close only. */
export const Rename: Story = {};

const blankContext = { ...sampleContext, name: '' };

/** A blank name is never saved; the field says so. */
export const EmptyName: Story = {
    args: { workContext: blankContext },
    // The provider must list the blank row too, or the live merge adopts the stored name on mount.
    decorators: [editorProvidersDecorator({ workContexts: [blankContext], allWorkContexts: [blankContext] })],
    // The dialog portals out of the canvas, so query the whole document.
    play: async () => {
        await expect(await within(document.body).findByText(/Name is required/)).toBeVisible();
    },
};
