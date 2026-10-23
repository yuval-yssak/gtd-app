import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useId, useMemo, useState } from 'react';
import type { NeighbourIds } from '../../lib/dragReorder';
import { hasAtLeastOne } from '../../lib/typeUtils';
import type { StoredItem } from '../../types/MyDB';
import styles from './MoveToSheet.module.css';

type Placement = 'above' | 'below';

interface MoveToSheetProps {
    /** The item being moved, or null when the sheet is closed. */
    item: StoredItem | null;
    /** The item's section — LIVE rows in display order (the item itself included). */
    sectionItems: readonly StoredItem[];
    sectionLabel: string;
    onClose: () => void;
    /** The visible neighbours the item lands between, by id — resolved against live rows at commit time. */
    onMove: (neighbours: NeighbourIds) => void;
}

/**
 * The neighbours an "Above X" / "Below X" pick resolves to among the other rows. Pure; unit-tested
 * in `tests/moveToSheet.test.ts`.
 */
export function neighboursRelativeTo(others: readonly { _id: string }[], targetId: string, placement: Placement): NeighbourIds {
    const idx = others.findIndex((other) => other._id === targetId);
    const slot = placement === 'above' ? idx : idx + 1;
    return { aboveId: others[slot - 1]?._id, belowId: others[slot]?._id };
}

/** "Top of section" / "Bottom of section" as neighbour ids. */
export function edgeNeighbours(others: readonly { _id: string }[], edge: 'top' | 'bottom'): NeighbourIds {
    return edge === 'top' ? { aboveId: undefined, belowId: others[0]?._id } : { aboveId: others.at(-1)?._id, belowId: undefined };
}

/**
 * Touch alternative to drag and drop (Phase 4): a bottom sheet with "Top of section", "Bottom of
 * section", and "Above… / Below…" with a searchable picker limited to the same section. Never
 * offers a date change — the section is fixed, like a drag.
 */
export function MoveToSheet({ item, sectionItems, sectionLabel, onClose, onMove }: MoveToSheetProps) {
    const [placement, setPlacement] = useState<Placement | null>(null);
    const [query, setQuery] = useState('');
    const titleId = useId();
    const others = useMemo(() => sectionItems.filter((row) => row._id !== item?._id), [sectionItems, item]);
    const matches = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return needle ? others.filter((row) => row.title.toLowerCase().includes(needle)) : others;
    }, [others, query]);
    const canMove = hasAtLeastOne(others);

    function close() {
        setPlacement(null);
        setQuery('');
        onClose();
    }

    function move(neighbours: NeighbourIds) {
        onMove(neighbours);
        close();
    }

    return (
        <Drawer
            anchor="bottom"
            open={item !== null}
            onClose={close}
            slotProps={{ paper: { className: styles.sheet, 'aria-labelledby': titleId, ...{ 'data-testid': 'nextActionMoveToSheet' } } }}
        >
            <Typography id={titleId} variant="subtitle1" className={styles.title}>
                Move “{item?.title}” within {sectionLabel}
            </Typography>
            {placement === null ? (
                <Stack className={styles.actions}>
                    <Button variant="outlined" onClick={() => move(edgeNeighbours(others, 'top'))} disabled={!canMove} data-testid="nextActionMoveToTop">
                        Top of section
                    </Button>
                    <Button variant="outlined" onClick={() => move(edgeNeighbours(others, 'bottom'))} disabled={!canMove} data-testid="nextActionMoveToBottom">
                        Bottom of section
                    </Button>
                    <Button variant="outlined" onClick={() => setPlacement('above')} disabled={!canMove} data-testid="nextActionMoveToAbove">
                        Above…
                    </Button>
                    <Button variant="outlined" onClick={() => setPlacement('below')} disabled={!canMove} data-testid="nextActionMoveToBelow">
                        Below…
                    </Button>
                    <Button onClick={close} data-testid="nextActionMoveToCancel">
                        Cancel
                    </Button>
                </Stack>
            ) : (
                <Stack className={styles.actions}>
                    <TextField
                        size="small"
                        autoFocus
                        label={placement === 'above' ? 'Above which item?' : 'Below which item?'}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        slotProps={{ htmlInput: { 'data-testid': 'nextActionMoveToSearch' } }}
                    />
                    <List dense className={styles.targets}>
                        {matches.map((row) => (
                            <ListItemButton
                                key={row._id}
                                onClick={() => move(neighboursRelativeTo(others, row._id, placement))}
                                data-testid="nextActionMoveToTarget"
                            >
                                <ListItemText primary={row.title} />
                            </ListItemButton>
                        ))}
                        {matches.length === 0 && (
                            <Typography variant="body2" color="text.secondary">
                                No items match.
                            </Typography>
                        )}
                    </List>
                    <Button onClick={() => setPlacement(null)}>Back</Button>
                </Stack>
            )}
        </Drawer>
    );
}
