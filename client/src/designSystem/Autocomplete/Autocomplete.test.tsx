// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Autocomplete } from './Autocomplete';

afterEach(cleanup);

// The page-level Escape listener (usePageEscapeToClose) listens on document; a key the picker claims never gets there.
function listenOnDocument() {
    const onKeyDown = vi.fn();
    const listener = (event: KeyboardEvent) => onKeyDown(event.key);
    document.addEventListener('keydown', listener);
    onTestFinished(() => document.removeEventListener('keydown', listener));
    return onKeyDown;
}

interface Person {
    id: string;
    name: string;
}

const PEOPLE: Person[] = [
    { id: 'p1', name: 'Dana' },
    { id: 'p2', name: 'Dov' },
];

function Picker({ onItemPicked, onSubmitText }: { onItemPicked: (person: Person) => void; onSubmitText: (text: string) => void }) {
    const [input, setInput] = useState('');
    const matches = PEOPLE.filter((person) => person.name.toLowerCase().includes(input.toLowerCase()));
    return (
        <Autocomplete
            aria-label="Add attendee"
            placeholder="Add attendee…"
            inputValue={input}
            onInputValueChange={setInput}
            items={input ? matches : []}
            itemKey={(person) => person.id}
            renderItem={(person) => person.name}
            onItemPicked={(person) => {
                onItemPicked(person);
                setInput('');
            }}
            onSubmitText={onSubmitText}
        />
    );
}

describe('Autocomplete', () => {
    it('suggests the caller-filtered items as the user types and reports a clicked pick', async () => {
        const onItemPicked = vi.fn();
        render(<Picker onItemPicked={onItemPicked} onSubmitText={vi.fn()} />);
        await userEvent.type(screen.getByRole('combobox', { name: 'Add attendee' }), 'da');
        await userEvent.click(await screen.findByRole('option', { name: 'Dana' }));
        expect(onItemPicked).toHaveBeenCalledWith(PEOPLE[0]);
        expect(screen.getByRole('combobox', { name: 'Add attendee' })).toHaveProperty('value', '');
    });

    it('picks the highlighted suggestion on Enter', async () => {
        const onItemPicked = vi.fn();
        render(<Picker onItemPicked={onItemPicked} onSubmitText={vi.fn()} />);
        await userEvent.type(screen.getByRole('combobox', { name: 'Add attendee' }), 'do');
        await screen.findByRole('option', { name: 'Dov' });
        await userEvent.keyboard('{ArrowDown}{Enter}');
        expect(onItemPicked).toHaveBeenCalledWith(PEOPLE[1]);
    });

    it('submits the full typed text once a highlighted suggestion has been filtered away', async () => {
        const onSubmitText = vi.fn();
        render(<Picker onItemPicked={vi.fn()} onSubmitText={onSubmitText} />);
        const input = screen.getByRole('combobox', { name: 'Add attendee' });
        await userEvent.type(input, 'd');
        await screen.findByRole('option', { name: 'Dana' });
        await userEvent.keyboard('{ArrowDown}');
        await userEvent.type(input, 'zz');
        await userEvent.keyboard('{Enter}');
        expect(onSubmitText).toHaveBeenCalledWith('dzz');
    });

    it('closes on Escape without letting the key reach the page, then submits the text on Enter', async () => {
        const onSubmitText = vi.fn();
        const onPageKeyDown = listenOnDocument();
        render(<Picker onItemPicked={vi.fn()} onSubmitText={onSubmitText} />);
        await userEvent.type(screen.getByRole('combobox', { name: 'Add attendee' }), 'd');
        await screen.findByRole('option', { name: 'Dana' });
        await userEvent.keyboard('{ArrowDown}{Escape}');
        expect(onPageKeyDown).not.toHaveBeenCalledWith('Escape');
        await userEvent.keyboard('{Enter}');
        expect(onSubmitText).toHaveBeenCalledWith('d');
    });

    it('lets Escape through to the page when no suggestions are open (page Escape-to-leave)', async () => {
        const onPageKeyDown = listenOnDocument();
        render(<Picker onItemPicked={vi.fn()} onSubmitText={vi.fn()} />);
        await userEvent.click(screen.getByRole('combobox', { name: 'Add attendee' }));
        await userEvent.keyboard('{Escape}');
        expect(onPageKeyDown).toHaveBeenCalledWith('Escape');
    });

    it('submits the typed text on Enter when no suggestion is highlighted', async () => {
        const onSubmitText = vi.fn();
        render(<Picker onItemPicked={vi.fn()} onSubmitText={onSubmitText} />);
        await userEvent.type(screen.getByRole('combobox', { name: 'Add attendee' }), 'new@example.com{Enter}');
        expect(onSubmitText).toHaveBeenCalledWith('new@example.com');
    });
});
