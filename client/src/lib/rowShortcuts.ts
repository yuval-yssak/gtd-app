/**
 * Letter shortcuts on list rows, and how a button advertises its shortcut. One source of truth for
 * the letters: the Next Actions list (`nextActionsKeys.ts`), the generic row handler
 * (`useGlobalShortcuts`), the tooltips (`RowActionButton`, `CopyIdButton`) and the legend
 * (`KeyboardShortcutsDialog`) all read `ROW_ACTION_KEYS`.
 */

/** The row buttons a letter can press. */
export type RowActionName = 'edit' | 'done' | 'copyId' | 'moveTo';

export const ROW_ACTION_KEYS: Record<RowActionName, string> = { edit: 'e', done: 'd', copyId: 'c', moveTo: 'm' };

/**
 * The letters every list page's rows answer to. Done and Move to stay on Next Actions, the only
 * list that guards a repeated Done (a second press on a routine's item would create a second
 * follow-up) and has a Move to sheet.
 */
export const EVERY_ROW_ACTIONS: readonly RowActionName[] = ['edit', 'copyId'];

/** The letters a ranked list other than Next Actions answers to (Inbox, Someday / Maybe, Waiting For): no Done letter there. */
export const RANKED_LIST_ROW_ACTIONS: readonly RowActionName[] = ['edit', 'copyId', 'moveTo'];

/** Marks a list row whose buttons the letters press, and the action each of its buttons performs. */
export const SHORTCUT_ROW_ATTR = 'data-shortcut-row';
export const ROW_ACTION_ATTR = 'data-row-action';

/** "Copy item ID (c)" — a tooltip that teaches its shortcut. */
export function withShortcutHint(label: string, key: string): string {
    return `${label} (${key})`;
}

/** The row action a bare letter presses, among `allowed`, or null. */
export function rowActionForKey(key: string, allowed: readonly RowActionName[]): RowActionName | null {
    return allowed.find((action) => ROW_ACTION_KEYS[action] === key.toLowerCase()) ?? null;
}

/**
 * Props for a row button that a letter presses: its action marker, the hint in its tooltip, and
 * `aria-keyshortcuts` so a screen reader announces the key with the button.
 */
export function rowActionButtonProps(action: RowActionName) {
    return { [ROW_ACTION_ATTR]: action, 'aria-keyshortcuts': ROW_ACTION_KEYS[action].toUpperCase() };
}

/** Spread on a list row (the ListItem) so the generic handler finds its buttons. */
export const SHORTCUT_ROW_PROPS = { [SHORTCUT_ROW_ATTR]: '' } as const;
