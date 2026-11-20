import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { withEscapeStepOut } from '../../test-utils/storybookEscapeStepOut';
import { MarkdownNotesEditor, NOTES_PLACEHOLDER } from './MarkdownNotesEditor';

function ControlledNotesEditor({ initialValue }: { initialValue: string }) {
    const [notes, setNotes] = useState(initialValue);
    return <MarkdownNotesEditor value={notes} onValueChange={setNotes} placeholder={NOTES_PLACEHOLDER} />;
}

const meta = {
    title: 'Components/MarkdownNotesEditor',
    component: ControlledNotesEditor,
    args: { initialValue: '' },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof ControlledNotesEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

async function focusEditor(canvasElement: HTMLElement) {
    const editor = await within(canvasElement).findByRole('textbox', { name: 'Notes (Markdown)' });
    await userEvent.click(editor);
    return editor;
}

export const Empty: Story = {};
const someNotes = { initialValue: 'Call **before noon** — ask about the `invoice`.' };

export const WithNotes: Story = { args: someNotes };

/** Typing: the accent ring. */
export const Editing: Story = {
    args: someNotes,
    play: async ({ canvasElement }) => {
        await expect(await focusEditor(canvasElement)).toHaveFocus();
    },
};

/** Escape parks focus on the editor box: the plain focus ring, so it never reads as typing. */
export const Parked: Story = {
    args: someNotes,
    decorators: [withEscapeStepOut],
    play: async ({ canvasElement }) => {
        await focusEditor(canvasElement);
        await userEvent.keyboard('{Escape}');
        await expect(within(canvasElement).getByTestId('markdownNotesEditor')).toHaveFocus();
    },
};
