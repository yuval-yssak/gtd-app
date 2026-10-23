import { type ChordPart, chordLabel } from '../../lib/platformKeys';
import { ROW_ACTION_KEYS, type RowActionName } from '../../lib/rowShortcuts';

const ACTION_WORDS: Record<RowActionName, string> = { edit: 'edits', done: 'marks it done', copyId: 'copies its id', moveTo: 'opens Move to' };

/**
 * A ranked list's screen-reader description, spelled for the platform (⌥ on a Mac, Alt elsewhere).
 * `actions` are the row letters this list answers to; `sectionNoun` names one section ("day", "list").
 */
export function reorderHintText(isApple: boolean, actions: readonly RowActionName[], sectionNoun: string): string {
    const label = (parts: ChordPart[]) => chordLabel(parts, isApple);
    const letters = actions.map((action) => `${ROW_ACTION_KEYS[action].toUpperCase()} ${ACTION_WORDS[action]}`).join(', ');
    return (
        'Arrow Up or Down moves between rows, Home and End to the first and last row, Arrow Right into the row’s buttons. ' +
        `Enter opens the row; ${letters}. ` +
        `Press Space to pick the row up, Arrow Up or Down to move it, ${label(['shift', 'up'])} or ${label(['shift', 'down'])} to jump to the top or bottom, ` +
        `Space to drop, Escape to cancel. ${label(['alt', 'up'])} or ${label(['alt', 'down'])} moves the row one slot; ` +
        `${label(['alt', 'shift', 'up'])} or ${label(['alt', 'shift', 'down'])} moves it to the top or bottom of its ${sectionNoun}.`
    );
}
