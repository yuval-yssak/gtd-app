import { useMemo, useState } from 'react';
import { Button, Drawer, Text, TextField } from '../../designSystem';
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
            side="bottom"
            open={item !== null}
            onClose={close}
            // The title names the sheet (Base UI wires it as the dialog's label).
            title={`Move “${item?.title ?? ''}” within ${sectionLabel}`}
            className={styles.sheet}
            data-testid="nextActionMoveToSheet"
        >
            {placement === null ? (
                <div className={styles.actions}>
                    <Button variant="outline" onClick={() => move(edgeNeighbours(others, 'top'))} disabled={!canMove} data-testid="nextActionMoveToTop">
                        Top of section
                    </Button>
                    <Button variant="outline" onClick={() => move(edgeNeighbours(others, 'bottom'))} disabled={!canMove} data-testid="nextActionMoveToBottom">
                        Bottom of section
                    </Button>
                    <Button variant="outline" onClick={() => setPlacement('above')} disabled={!canMove} data-testid="nextActionMoveToAbove">
                        Above…
                    </Button>
                    <Button variant="outline" onClick={() => setPlacement('below')} disabled={!canMove} data-testid="nextActionMoveToBelow">
                        Below…
                    </Button>
                    <Button tone="neutral" onClick={close} data-testid="nextActionMoveToCancel">
                        Cancel
                    </Button>
                </div>
            ) : (
                <div className={styles.actions}>
                    <TextField
                        autoFocus
                        fullWidth
                        label={placement === 'above' ? 'Above which item?' : 'Below which item?'}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        inputProps={{ 'data-testid': 'nextActionMoveToSearch' }}
                    />
                    <ul className={styles.targets}>
                        {matches.map((row) => (
                            <li key={row._id}>
                                <button
                                    type="button"
                                    className={styles.target}
                                    onClick={() => move(neighboursRelativeTo(others, row._id, placement))}
                                    data-testid="nextActionMoveToTarget"
                                >
                                    {row.title}
                                </button>
                            </li>
                        ))}
                    </ul>
                    {matches.length === 0 && (
                        <Text variant="bodySm" tone="secondary">
                            No items match.
                        </Text>
                    )}
                    <Button tone="neutral" onClick={() => setPlacement(null)}>
                        Back
                    </Button>
                </div>
            )}
        </Drawer>
    );
}
