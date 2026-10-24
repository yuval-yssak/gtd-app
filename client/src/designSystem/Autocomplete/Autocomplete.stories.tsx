import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { userEvent, within } from 'storybook/test';
import { Autocomplete } from './Autocomplete';

const PEOPLE = ['Dana Levi', 'Dov Cohen', 'Maya Ben-David'];

function AttendeePicker() {
    const [input, setInput] = useState('');
    const matches = PEOPLE.filter((name) => name.toLowerCase().includes(input.trim().toLowerCase()));
    return (
        <Autocomplete
            aria-label="Add attendee"
            placeholder="Add attendee…"
            inputValue={input}
            onInputValueChange={setInput}
            items={input.trim() ? matches : []}
            itemKey={(name) => name}
            renderItem={(name) => name}
            onItemPicked={() => setInput('')}
            onSubmitText={() => setInput('')}
        />
    );
}

const meta = {
    title: 'Design System/Autocomplete',
    component: AttendeePicker,
} satisfies Meta<typeof AttendeePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Empty — no suggestions until the user types. */
export const Empty: Story = {};

/** Typed "d" — the matching suggestions are listed. */
export const WithSuggestions: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Add attendee' }), 'd');
        await within(document.body).findByRole('option', { name: 'Dana Levi' });
    },
};
