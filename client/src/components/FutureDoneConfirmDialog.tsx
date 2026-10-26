import { useState } from 'react';
import { AlertDialog, Button, DialogActions, DialogDescription, DialogTitle } from '../designSystem';
import { describeEventStart, startsOnFutureDay } from '../lib/futureDoneConfirm';
import type { StoredItem } from '../types/MyDB';

interface FutureDoneConfirmDialogProps {
    open: boolean;
    /** The calendar item about to be marked done. Kept after close so the text survives the exit animation. */
    item: StoredItem | undefined;
    onCancel: () => void;
    onConfirm: () => void;
}

/** Asks before completing a calendar item that starts on a later day — that click is usually aimed at the wrong row. */
export function FutureDoneConfirmDialog({ open, item, onCancel, onConfirm }: FutureDoneConfirmDialogProps) {
    return (
        <AlertDialog open={open} onClose={onCancel} size="sm" fullWidth data-testid="futureDoneConfirmDialog">
            <DialogTitle>Mark a future event done?</DialogTitle>
            <DialogDescription>
                {item ? (
                    <>
                        "{item.title}" is on {describeEventStart(item)}. Mark it done anyway?
                    </>
                ) : null}
            </DialogDescription>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="solid" onClick={onConfirm} data-testid="futureDoneConfirmButton">
                    Mark done anyway
                </Button>
            </DialogActions>
        </AlertDialog>
    );
}

interface PendingFutureDone {
    itemId: string;
    markDone: (latest: StoredItem) => void;
}

/**
 * The gate every "mark a calendar item done" surface runs through: `confirmDone` runs `markDone`
 * at once unless the item starts on a future day, in which case it opens the dialog (spread
 * `dialogProps` onto `FutureDoneConfirmDialog`) and runs it only on confirm.
 *
 * `liveItems` is the caller's live row list. The dialog can stay open across syncs, so the confirm
 * resolves the item afresh and hands `markDone` THAT row — completing the click-time snapshot would
 * overwrite a remote edit under LWW, or revive an item trashed meanwhile (then nothing is written).
 */
export function useFutureDoneConfirm(liveItems: readonly StoredItem[]) {
    const [pending, setPending] = useState<PendingFutureDone | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const pendingItem = pending ? liveItems.find((item) => item._id === pending.itemId) : undefined;

    function confirmDone(item: StoredItem, markDone: (latest: StoredItem) => void) {
        if (!startsOnFutureDay(item)) {
            markDone(item);
            return;
        }
        setPending({ itemId: item._id, markDone });
        setIsOpen(true);
    }

    function onConfirm() {
        if (!isOpen) {
            return;
        }
        setIsOpen(false);
        if (pending && pendingItem?.status === 'calendar') {
            pending.markDone(pendingItem);
        }
    }

    // A row that left the device mid-dialog (synced away, account removed) closes it: nothing to confirm.
    return { confirmDone, dialogProps: { open: isOpen && pendingItem !== undefined, item: pendingItem, onCancel: () => setIsOpen(false), onConfirm } };
}
