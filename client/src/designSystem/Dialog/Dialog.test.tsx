// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen } from '../../lib/keyboardRegionDom';
import { Button } from '../Button/Button';
import { AlertDialog, Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from './Dialog';

afterEach(cleanup);

function RenameDialog({ onClose = vi.fn() }: { onClose?: (reason: string) => void }) {
    return (
        <Dialog open onClose={onClose} data-testid="renameDialog">
            <DialogTitle>Rename context</DialogTitle>
            <DialogContent>
                <input aria-label="Name" />
            </DialogContent>
            <DialogActions>
                <Button>Save</Button>
            </DialogActions>
        </Dialog>
    );
}

describe('Dialog', () => {
    it('is a dialog named by its title, carrying the test id', async () => {
        render(<RenameDialog />);
        const dialog = await screen.findByRole('dialog', { name: 'Rename context' });
        expect(dialog.getAttribute('data-testid')).toBe('renameDialog');
    });

    it('moves focus inside on open', async () => {
        render(<RenameDialog />);
        await screen.findByRole('dialog');
        await vi.waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    });

    it('marks itself as an open modal so page shortcuts go quiet', async () => {
        render(<RenameDialog />);
        await screen.findByRole('dialog');
        expect(isModalOpen()).toBe(true);
    });

    it('reports Escape as the close reason', async () => {
        const onClose = vi.fn();
        render(<RenameDialog onClose={onClose} />);
        await screen.findByRole('dialog');
        await userEvent.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledWith('escapeKey');
    });

    it('unmounts when closed, so isModalOpen turns false again', async () => {
        function Harness() {
            const [isOpen, setIsOpen] = useState(true);
            return (
                <Dialog open={isOpen} onClose={() => setIsOpen(false)}>
                    <DialogTitle>Rename context</DialogTitle>
                    <DialogActions>
                        <Button onClick={() => setIsOpen(false)}>Close</Button>
                    </DialogActions>
                </Dialog>
            );
        }
        render(<Harness />);
        await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
        await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(isModalOpen()).toBe(false);
    });
});

describe('Dialog dismissal and focus', () => {
    function pressOutside() {
        return userEvent.pointer({ keys: '[MouseLeft]', target: document.body });
    }

    it('reports a backdrop press as "backdropClick"', async () => {
        const onClose = vi.fn();
        render(<RenameDialog onClose={onClose} />);
        await screen.findByRole('dialog');
        await pressOutside();
        expect(onClose).toHaveBeenCalledWith('backdropClick');
    });

    it('ignores a backdrop press with disableBackdropClose, but still closes on Escape', async () => {
        const onClose = vi.fn();
        render(
            <Dialog open onClose={onClose} disableBackdropClose>
                <DialogTitle>Full sync required</DialogTitle>
                <DialogActions>
                    <Button>Export</Button>
                </DialogActions>
            </Dialog>,
        );
        await screen.findByRole('dialog');
        await pressOutside();
        expect(onClose).not.toHaveBeenCalled();
        await userEvent.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledWith('escapeKey');
    });

    it('traps Tab inside the dialog', async () => {
        render(
            <>
                <button type="button">Behind</button>
                <RenameDialog />
            </>,
        );
        const dialog = await screen.findByRole('dialog');
        // Base UI traps with focus-guard sentinels that hand focus back a tick later, hence the wait.
        for (let step = 0; step < 4; step++) {
            await userEvent.tab();
            await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
        }
    });

    it('returns focus to the element that opened it', async () => {
        function Harness() {
            const [isOpen, setIsOpen] = useState(false);
            return (
                <>
                    <Button onClick={() => setIsOpen(true)}>Rename</Button>
                    <Dialog open={isOpen} onClose={() => setIsOpen(false)}>
                        <DialogTitle>Rename context</DialogTitle>
                        <DialogActions>
                            <Button onClick={() => setIsOpen(false)}>Close</Button>
                        </DialogActions>
                    </Dialog>
                </>
            );
        }
        render(<Harness />);
        const opener = screen.getByRole('button', { name: 'Rename' });
        await userEvent.click(opener);
        await userEvent.keyboard('{Escape}');
        await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    });
});

describe('AlertDialog', () => {
    it('never closes on a backdrop press', async () => {
        const onClose = vi.fn();
        render(
            <AlertDialog open onClose={onClose}>
                <DialogTitle>Delete routine?</DialogTitle>
                <DialogActions>
                    <Button tone="danger">Delete</Button>
                </DialogActions>
            </AlertDialog>,
        );
        await screen.findByRole('alertdialog');
        await userEvent.pointer({ keys: '[MouseLeft]', target: document.body });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('opens with focus on the dialog, not on its first (destructive) button', async () => {
        render(
            <AlertDialog open onClose={vi.fn()}>
                <DialogTitle>Delete routine?</DialogTitle>
                <DialogActions>
                    <Button tone="danger">Delete</Button>
                    <Button>Cancel</Button>
                </DialogActions>
            </AlertDialog>,
        );
        const dialog = await screen.findByRole('alertdialog');
        await vi.waitFor(() => expect(document.activeElement).toBe(dialog));
    });

    it('is an alertdialog named by its title and described by its description', async () => {
        render(
            <AlertDialog open onClose={vi.fn()}>
                <DialogTitle>Delete routine?</DialogTitle>
                <DialogContent>
                    <DialogDescription>Future items are trashed.</DialogDescription>
                </DialogContent>
                <DialogActions>
                    <Button>Cancel</Button>
                    <Button tone="danger">Delete</Button>
                </DialogActions>
            </AlertDialog>,
        );
        const dialog = await screen.findByRole('alertdialog', { name: 'Delete routine?' });
        expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('Future items are trashed.').id);
        expect(isModalOpen()).toBe(true);
    });
});
