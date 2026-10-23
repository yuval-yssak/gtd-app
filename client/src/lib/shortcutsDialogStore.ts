/**
 * Open/closed state of the app-wide keyboard shortcuts legend. A module-level store (like
 * `undoStore`) so the global `?` key and any page's keyboard button can open the one dialog the
 * layout mounts, without threading a callback through context.
 */
let isOpen = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
    if (next === isOpen) {
        return;
    }
    isOpen = next;
    for (const listener of listeners) {
        listener();
    }
}

export const openShortcutsDialog = () => setOpen(true);
export const closeShortcutsDialog = () => setOpen(false);
export const isShortcutsDialogOpen = () => isOpen;

export function subscribeShortcutsDialog(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
