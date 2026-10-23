import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { Fragment, useSyncExternalStore } from 'react';
import { STATUS_KEYS } from '../lib/editorShortcuts';
import { GO_TO_TARGETS } from '../lib/globalShortcuts';
import { type ChordPart, chordList, isApplePlatform } from '../lib/platformKeys';
import { EVERY_ROW_ACTIONS, ROW_ACTION_KEYS, type RowActionName } from '../lib/rowShortcuts';
import { closeShortcutsDialog, isShortcutsDialogOpen, subscribeShortcutsDialog } from '../lib/shortcutsDialogStore';
import styles from './KeyboardShortcutsDialog.module.css';

/** A legend row: platform-spelled chords, or a literal key sequence ("g i") that has no platform variants. */
type ShortcutRow = { chords: ChordPart[][]; does: string } | { sequence: string; does: string };

interface ShortcutGroup {
    title: string;
    rows: ShortcutRow[];
}

/** What each row letter does, as the legend says it (People and Contexts rows have no copy button; contexts rename). */
const ROW_ACTION_LEGEND: Record<RowActionName, string> = {
    edit: 'Edit (Rename on contexts)',
    copyId: 'Copy the id, where the row has a copy button',
    done: 'Mark done',
    moveTo: 'Move to…',
};

/** Keys a Mac lacks (Home/End, PgUp/PgDn, F6) are spelled with their Fn stand-ins there. */
const GROUPS: ShortcutGroup[] = [
    {
        title: 'Anywhere',
        rows: [
            { chords: [['tab']], does: 'Next region — the menu, accounts, a page’s filters and list are one stop each (Shift+Tab back)' },
            {
                chords: [['f6'], ['shift', 'f6']],
                does: 'Jump to the next / previous region',
            },
            { sequence: '?', does: 'This list of shortcuts' },
            { sequence: '/', does: 'Search the list' },
            { sequence: 'c', does: 'Capture to the inbox (outside a list row, where c copies the id)' },
        ],
    },
    {
        title: 'Inside a region',
        rows: [
            { chords: [['up'], ['down']], does: 'Previous / next item (← / → in a row of buttons or filters)' },
            { chords: [['home'], ['end']], does: 'First / last item' },
            { chords: [['enter'], ['space']], does: 'Open / press' },
        ],
    },
    {
        title: 'On a focused list row (any list)',
        rows: EVERY_ROW_ACTIONS.map((action) => ({ sequence: ROW_ACTION_KEYS[action], does: ROW_ACTION_LEGEND[action] })),
    },
    {
        title: 'Go to (press g, then the letter)',
        rows: GO_TO_TARGETS.map((target) => ({ sequence: `g ${target.key}`, does: target.label })),
    },
    {
        title: 'Lists with a manual order (Next Actions, Inbox, Someday / Maybe, Waiting For by date)',
        rows: [
            { chords: [['right']], does: 'Into the row’s buttons (← or Esc back)' },
            {
                chords: [
                    ['alt', 'up'],
                    ['alt', 'down'],
                ],
                does: 'Move one slot up / down',
            },
            {
                chords: [
                    ['alt', 'shift', 'up'],
                    ['alt', 'shift', 'down'],
                ],
                does: 'Move to the top / bottom of its day (or list)',
            },
            { sequence: ROW_ACTION_KEYS.moveTo, does: ROW_ACTION_LEGEND.moveTo },
            { sequence: ROW_ACTION_KEYS.done, does: `${ROW_ACTION_LEGEND.done} (Next Actions)` },
        ],
    },
    {
        title: 'Picking a row up (Space)',
        rows: [
            { chords: [['up'], ['down']], does: 'Move one slot' },
            {
                chords: [
                    ['shift', 'up'],
                    ['shift', 'down'],
                ],
                does: 'Jump to the top / bottom of its day (or list)',
            },
            { chords: [['pageUp'], ['pageDown']], does: 'Move five slots' },
            { chords: [['space']], does: 'Drop' },
            { chords: [['esc']], does: 'Put it back' },
        ],
    },
    {
        title: 'In the item editor',
        rows: [
            { chords: [['mod', 'enter']], does: 'Save' },
            { chords: [['esc']], does: 'Close' },
            {
                sequence: STATUS_KEYS.map((entry) => entry.key).join(' '),
                does: 'Pick a status: Inbox, Next Action, Calendar, Waiting For, Someday, Routine, Done, Trash (outside a text field)',
            },
            {
                chords: [
                    ['alt', 'up'],
                    ['alt', 'down'],
                ],
                does: 'Move the item one slot in its list',
            },
            {
                chords: [
                    ['alt', 'shift', 'up'],
                    ['alt', 'shift', 'down'],
                ],
                does: 'Move it to the top / bottom of its day (or list)',
            },
        ],
    },
];

function keysOf(row: ShortcutRow, isApple: boolean): string {
    return 'chords' in row ? chordList(row.chords, isApple) : row.sequence;
}

/** The app-wide keyboard legend: opened by `?` anywhere or by a page's keyboard button (see `shortcutsDialogStore`). */
export function KeyboardShortcutsDialog() {
    const open = useSyncExternalStore(subscribeShortcutsDialog, isShortcutsDialogOpen);
    const isApple = isApplePlatform();
    return (
        <Dialog
            open={open}
            onClose={closeShortcutsDialog}
            fullWidth
            maxWidth="sm"
            aria-labelledby="keyboard-shortcuts-title"
            slotProps={{ paper: { ...{ 'data-testid': 'keyboardShortcutsDialog' } } }}
        >
            <DialogTitle id="keyboard-shortcuts-title">Keyboard shortcuts</DialogTitle>
            <DialogContent>
                <Table size="small">
                    <TableBody>
                        {GROUPS.map((group) => (
                            <Fragment key={group.title}>
                                <TableRow>
                                    <TableCell colSpan={2}>
                                        {/* Plain element: a CSS-module rule on the TableCell loses to MUI's emotion styles. */}
                                        <span className={styles.groupTitle}>{group.title}</span>
                                    </TableCell>
                                </TableRow>
                                {group.rows.map((row) => (
                                    <TableRow key={`${group.title}-${row.does}`}>
                                        <TableCell className={styles.chord}>{keysOf(row, isApple)}</TableCell>
                                        <TableCell>{row.does}</TableCell>
                                    </TableRow>
                                ))}
                            </Fragment>
                        ))}
                    </TableBody>
                </Table>
                <Typography variant="body2" color="text.secondary" className={styles.letters}>
                    Letter shortcuts never fire while you type in a field.
                </Typography>
            </DialogContent>
        </Dialog>
    );
}
