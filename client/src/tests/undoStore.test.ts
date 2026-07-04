import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissCurrentUndo, getCurrentUndo, offerUndo, resetUndoStore, runCurrentUndo, subscribeToUndo } from '../lib/undoStore';

afterEach(() => {
    resetUndoStore();
});

describe('undoStore', () => {
    it('holds a single offer and notifies subscribers on every change', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToUndo(listener);

        offerUndo({ key: 'item:1:text', message: 'Saved', undo: async () => {} });
        expect(getCurrentUndo()?.message).toBe('Saved');
        expect(listener).toHaveBeenCalledTimes(1);

        dismissCurrentUndo();
        expect(getCurrentUndo()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('same-key replacement is silent (continuing burst); different key expires the old offer', () => {
        const onExpireA = vi.fn();
        const onExpireB = vi.fn();

        offerUndo({ key: 'item:1:text', message: 'Saved', undo: async () => {}, onExpire: onExpireA });
        offerUndo({ key: 'item:1:text', message: 'Saved', undo: async () => {}, onExpire: onExpireA });
        expect(onExpireA).not.toHaveBeenCalled();

        offerUndo({ key: 'person:2', message: 'Person saved', undo: async () => {}, onExpire: onExpireB });
        expect(onExpireA).toHaveBeenCalledTimes(1);
        expect(onExpireB).not.toHaveBeenCalled();
    });

    it('bumps offerId on same-key replacement so the snackbar restarts its auto-hide timer', () => {
        offerUndo({ key: 'item:1:text', message: 'Saved', undo: async () => {} });
        const first = getCurrentUndo();
        offerUndo({ key: 'item:1:text', message: 'Saved', undo: async () => {} });
        const second = getCurrentUndo();
        expect(second?.offerId).not.toBe(first?.offerId);
    });

    it('dismiss fires onExpire; undo runs the callback and does NOT fire onExpire', async () => {
        const onExpire = vi.fn();
        const undo = vi.fn().mockResolvedValue(undefined);

        offerUndo({ key: 'a', message: 'Saved', undo, onExpire });
        dismissCurrentUndo();
        expect(onExpire).toHaveBeenCalledTimes(1);

        offerUndo({ key: 'a', message: 'Saved', undo, onExpire });
        await runCurrentUndo();
        expect(undo).toHaveBeenCalledTimes(1);
        expect(onExpire).toHaveBeenCalledTimes(1); // unchanged — undo path skips expire
        expect(getCurrentUndo()).toBeNull();
    });

    it('dismiss and undo are safe no-ops when nothing is offered', async () => {
        expect(() => dismissCurrentUndo()).not.toThrow();
        await expect(runCurrentUndo()).resolves.toBeUndefined();
    });
});
