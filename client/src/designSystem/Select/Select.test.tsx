// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen } from '../../lib/keyboardRegionDom';
import { Select, type SelectOption } from './Select';

afterEach(cleanup);

const CALENDARS: SelectOption<string>[] = [
    { value: '', label: 'Default' },
    { value: 'a-work', label: 'Work', group: 'a@example.com' },
    { value: 'a-home', label: 'Home', group: 'a@example.com' },
    { value: 'b-team', label: 'Team', group: 'b@example.com' },
];

async function openSelect() {
    await act(async () => {
        fireEvent.click(screen.getByRole('combobox', { name: 'Calendar' }));
    });
    return screen.getByRole('listbox');
}

describe('Select', () => {
    it('names its combobox by the visible label', () => {
        render(<Select label="Calendar" value="" onValueChange={() => {}} options={CALENDARS} />);
        expect(screen.getByRole('combobox', { name: 'Calendar' })).toBeDefined();
    });

    it('lists ungrouped options first, then one labelled group per account', async () => {
        render(<Select label="Calendar" value="" onValueChange={() => {}} options={CALENDARS} />);
        const listbox = await openSelect();
        const groups = within(listbox).getAllByRole('group');
        expect(groups.map((group) => within(group).getAllByRole('option').length)).toEqual([2, 1]);
        const [firstGroup] = groups;
        if (!firstGroup) throw new Error('expected an account group');
        expect(within(firstGroup).getByText('a@example.com')).toBeDefined();
        expect(within(listbox).getByRole('option', { name: 'Default' })).toBeDefined();
    });

    it('reports the picked value', async () => {
        const onValueChange = vi.fn();
        render(<Select label="Calendar" value="" onValueChange={onValueChange} options={CALENDARS} />);
        const listbox = await openSelect();
        // A full pointer sequence: Base UI commits a pick on pointer release, not on a bare click event.
        await userEvent.click(within(listbox).getByRole('option', { name: 'Team' }));
        expect(onValueChange).toHaveBeenCalledWith('b-team');
    });
});

describe('Select popup', () => {
    it('is a combobox named by its label with option roles (e2e: combobox { name: "Calendar" })', async () => {
        const onValueChange = vi.fn();
        render(
            <Select
                label="Calendar"
                value="work"
                onValueChange={onValueChange}
                options={[
                    { value: 'work', label: 'Work' },
                    { value: 'home', label: 'Home' },
                ]}
            />,
        );
        const trigger = screen.getByRole('combobox', { name: 'Calendar' });
        expect(trigger.textContent).toContain('Work');
        await userEvent.click(trigger);
        await userEvent.click(await screen.findByRole('option', { name: 'Home' }));
        expect(onValueChange).toHaveBeenCalledWith('home');
    });

    it('counts as an open modal while its list is open, and closes on Escape', async () => {
        render(
            <Select
                label="Calendar"
                value="work"
                onValueChange={vi.fn()}
                options={[
                    { value: 'work', label: 'Work' },
                    { value: 'home', label: 'Home' },
                ]}
            />,
        );
        await userEvent.click(screen.getByRole('combobox', { name: 'Calendar' }));
        await screen.findByRole('listbox');
        expect(isModalOpen()).toBe(true);
        await userEvent.keyboard('{Escape}');
        await vi.waitFor(() => expect(isModalOpen()).toBe(false));
    });
});
