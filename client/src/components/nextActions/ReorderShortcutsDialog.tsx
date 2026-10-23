import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { Fragment } from 'react';
import { type ChordPart, chordList } from '../../lib/platformKeys';
import styles from './ReorderShortcutsDialog.module.css';

interface ShortcutRow {
    chords: ChordPart[][];
    does: string;
}

interface ShortcutGroup {
    title: string;
    rows: ShortcutRow[];
}

/** The keyboard model of the Next Actions list, in the order a user learns it. Keys a Mac lacks (Home/End, PgUp/PgDn) are spelled with their Fn stand-ins there. */
const GROUPS: ShortcutGroup[] = [
    {
        title: 'Moving around',
        rows: [
            { chords: [['tab']], does: 'Into the list (then out of it)' },
            { chords: [['up'], ['down']], does: 'Previous / next row' },
            { chords: [['home'], ['end']], does: 'First / last row' },
            { chords: [['right']], does: 'Into the row’s buttons (← or Esc back)' },
        ],
    },
    {
        title: 'On a row',
        rows: [
            { chords: [['enter']], does: 'Open' },
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
                does: 'Move to the top / bottom of its day',
            },
        ],
    },
    {
        title: 'Picking a row up',
        rows: [
            { chords: [['space']], does: 'Pick up / drop' },
            { chords: [['up'], ['down']], does: 'Move one slot' },
            {
                chords: [
                    ['shift', 'up'],
                    ['shift', 'down'],
                ],
                does: 'Jump to the top / bottom of its day',
            },
            { chords: [['pageUp'], ['pageDown']], does: 'Move five slots' },
            { chords: [['esc']], does: 'Put it back' },
        ],
    },
];

/** Bare letters are spelled in the row text, not as chords — they have no platform variants. */
const LETTERS = 'E edits, D marks done, C copies the id, M opens “Move to…”.';

interface Props {
    open: boolean;
    onClose: () => void;
    /** Spell chords with Mac glyphs (⌥⇧↑) rather than key names (Alt+Shift+↑). */
    isApple: boolean;
}

/** The keyboard legend behind the keyboard icon beside the list search on Next Actions. */
export function ReorderShortcutsDialog({ open, onClose, isApple }: Props) {
    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs" slotProps={{ paper: { ...{ 'data-testid': 'nextActionsShortcutsDialog' } } }}>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogContent>
                <Table size="small">
                    <TableBody>
                        {GROUPS.map((group) => (
                            <Fragment key={group.title}>
                                <TableRow>
                                    <TableCell colSpan={2} className={styles.groupTitle}>
                                        {group.title}
                                    </TableCell>
                                </TableRow>
                                {group.rows.map((row) => (
                                    <TableRow key={row.does}>
                                        <TableCell className={styles.chord}>{chordList(row.chords, isApple)}</TableCell>
                                        <TableCell>{row.does}</TableCell>
                                    </TableRow>
                                ))}
                            </Fragment>
                        ))}
                    </TableBody>
                </Table>
                <Typography variant="body2" color="text.secondary" className={styles.letters}>
                    {LETTERS}
                </Typography>
            </DialogContent>
        </Dialog>
    );
}
