// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FutureDoneConfirmDialog, useFutureDoneConfirm } from '../components/FutureDoneConfirmDialog';
import type { StoredItem } from '../types/MyDB';

afterEach(cleanup);

function calendarItemStarting(start: dayjs.Dayjs): StoredItem {
    return {
        _id: 'item1',
        userId: 'user1',
        status: 'calendar',
        title: 'Dentist',
        timeStart: start.toISOString(),
        timeEnd: start.add(30, 'minute').toISOString(),
        createdTs: '2026-10-01T00:00:00.000Z',
        updatedTs: '2026-10-01T00:00:00.000Z',
    };
}

const tomorrowItem = () => calendarItemStarting(dayjs().add(1, 'day').startOf('day').add(1, 'minute'));

/** `item` plays the provider's live row: rerendering with a new one models a sync landing mid-dialog. */
function Harness({ item, onMarkDone, isItemGone = false }: { item: StoredItem; onMarkDone: (latest: StoredItem) => void; isItemGone?: boolean }) {
    const futureDone = useFutureDoneConfirm(isItemGone ? [] : [item]);
    return (
        <>
            <button type="button" onClick={() => futureDone.confirmDone(item, onMarkDone)}>
                Mark done
            </button>
            <FutureDoneConfirmDialog {...futureDone.dialogProps} />
        </>
    );
}

async function clickMarkDone() {
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
}

async function confirmAnyway() {
    await userEvent.click(screen.getByRole('button', { name: 'Mark done anyway' }));
}

describe('useFutureDoneConfirm', () => {
    it('marks an item starting later today done at once, without asking', async () => {
        const onMarkDone = vi.fn();
        const item = calendarItemStarting(dayjs().endOf('day').subtract(1, 'minute'));
        render(<Harness item={item} onMarkDone={onMarkDone} />);
        await clickMarkDone();
        expect(onMarkDone).toHaveBeenCalledExactlyOnceWith(item);
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('asks before marking an item that starts on a future day, and marks it once confirmed', async () => {
        const onMarkDone = vi.fn();
        const item = tomorrowItem();
        render(<Harness item={item} onMarkDone={onMarkDone} />);
        await clickMarkDone();
        const dialog = await screen.findByRole('alertdialog', { name: 'Mark a future event done?' });
        expect(dialog.textContent).toContain('Dentist');
        expect(onMarkDone).not.toHaveBeenCalled();

        await confirmAnyway();
        expect(onMarkDone).toHaveBeenCalledExactlyOnceWith(item);
        await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    });

    it('leaves the item alone when the user cancels', async () => {
        const onMarkDone = vi.fn();
        render(<Harness item={calendarItemStarting(dayjs().add(3, 'day'))} onMarkDone={onMarkDone} />);
        await clickMarkDone();
        await screen.findByRole('alertdialog');
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(onMarkDone).not.toHaveBeenCalled();
    });

    it('confirms against the live row: an edit synced while the dialog is open is shown and kept', async () => {
        const onMarkDone = vi.fn();
        const item = tomorrowItem();
        const { rerender } = render(<Harness item={item} onMarkDone={onMarkDone} />);
        await clickMarkDone();
        await screen.findByRole('alertdialog');

        const renamed = { ...item, title: 'Dentist (moved clinic)', updatedTs: '2026-10-02T00:00:00.000Z' };
        rerender(<Harness item={renamed} onMarkDone={onMarkDone} />);
        expect(screen.getByRole('alertdialog').textContent).toContain('Dentist (moved clinic)');

        await confirmAnyway();
        expect(onMarkDone).toHaveBeenCalledExactlyOnceWith(renamed);
    });

    it('does nothing on confirm when the item stopped being a calendar item meanwhile', async () => {
        const onMarkDone = vi.fn();
        const item = tomorrowItem();
        const { rerender } = render(<Harness item={item} onMarkDone={onMarkDone} />);
        await clickMarkDone();
        await screen.findByRole('alertdialog');

        rerender(<Harness item={{ ...item, status: 'trash' }} onMarkDone={onMarkDone} />);
        await confirmAnyway();
        expect(onMarkDone).not.toHaveBeenCalled();
    });

    it('closes the dialog when the item vanishes from the device meanwhile', async () => {
        const onMarkDone = vi.fn();
        const item = tomorrowItem();
        const { rerender } = render(<Harness item={item} onMarkDone={onMarkDone} />);
        await clickMarkDone();
        await screen.findByRole('alertdialog');

        rerender(<Harness item={item} onMarkDone={onMarkDone} isItemGone />);
        await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(onMarkDone).not.toHaveBeenCalled();
    });
});
