import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
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
    decorators: [editorProvidersDecorator({ workContexts: sampleWorkContexts })],
    args: { db: mockDb, workContext: sampleContext, onClose: fn() },
} satisfies Meta<typeof WorkContextEditDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rename an existing context — autosaving, Close only. */
export const Rename: Story = {};

/** A blank name is never saved; the field says so. */
export const EmptyName: Story = { args: { workContext: { ...sampleContext, name: '' } } };
