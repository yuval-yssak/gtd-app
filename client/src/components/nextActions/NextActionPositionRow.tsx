import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useMemo, useState, useTransition } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { reorderItem } from '../../db/itemMutations';
import { POSITION_MOVE_ATTR } from '../../hooks/useEditorShortcuts';
import { useTodayIso } from '../../hooks/useTodayIso';
import type { NeighbourIds } from '../../lib/dragReorder';
import { daySectionOf, positionMoves, positionSectionLabel, sectionOwnerIds } from '../../lib/nextActionPosition';
import { chordLabel, isApplePlatform } from '../../lib/platformKeys';
import type { MyDB, StoredItem } from '../../types/MyDB';
import { MoveToSheet } from './MoveToSheet';
import styles from './NextActionPositionRow.module.css';

interface Props {
    db: IDBPDatabase<MyDB>;
    /** The STORED item (not the form): the position is among the rows of the day it is saved on. */
    item: StoredItem;
    /**
     * Runs before the move: the editor writes its pending text autosave to IDB here (LOCAL only,
     * never the network push — a reorder is an offline write), since that save writes the editor's
     * snapshot of the row and would put the OLD rank back if it fired between the reorder's write
     * and the refresh.
     */
    onBeforeMove: () => Promise<void>;
}

/**
 * The editor's way to raise or lower a next action's priority without leaving it: Top / Up / Down /
 * Bottom within the day the item is saved on, plus "Move to…" for a specific neighbour. Writes
 * through the same `reorderItem` commit as every list gesture; the editor's live merge then adopts
 * the new rank silently (no form field reads it).
 */
export function NextActionPositionRow({ db, item, onBeforeMove }: Props) {
    // Each button names its key (native title: a Tooltip wrapper would break the ButtonGroup); the editor's Alt(⌥)+arrows press them.
    const isApple = useMemo(isApplePlatform, []);
    const { items, refreshItems } = useAppData();
    const todayIso = useTodayIso();
    const [isPending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [isSheetOpen, setIsSheetOpen] = useState(false);
    const section = useMemo(() => daySectionOf(items, item, todayIso), [items, item, todayIso]);
    const moves = useMemo(() => positionMoves(section, item._id), [section, item._id]);
    const label = positionSectionLabel(item, todayIso);

    function move(neighbours: NeighbourIds | null) {
        if (!neighbours) {
            return;
        }
        startTransition(async () => {
            try {
                await onBeforeMove();
                const moved = await reorderItem(db, { sectionItems: section, itemId: item._id, ...neighbours, ownerIds: sectionOwnerIds(items, item) });
                if (moved) {
                    await refreshItems();
                }
                setError(null);
            } catch (err) {
                console.error('[item-editor] reorder failed', err);
                setError('Could not save the new position');
            }
        });
    }

    return (
        <Stack className={styles.row} data-testid="nextActionPositionRow">
            <FormLabel className={styles.label}>Position in {label}</FormLabel>
            <Stack direction="row" className={styles.controls}>
                {/* Each button states `isPending` itself: a child's own `disabled` prop overrides the group's. */}
                <ButtonGroup size="small" variant="outlined" aria-label="Change position">
                    <Button
                        onClick={() => move(moves.top)}
                        disabled={isPending || !moves.top}
                        data-testid="nextActionPositionTop"
                        title={`Top (${chordLabel(['alt', 'shift', 'up'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'top' }}
                    >
                        Top
                    </Button>
                    <Button
                        onClick={() => move(moves.up)}
                        disabled={isPending || !moves.up}
                        data-testid="nextActionPositionUp"
                        title={`Up (${chordLabel(['alt', 'up'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'up' }}
                    >
                        Up
                    </Button>
                    <Button
                        onClick={() => move(moves.down)}
                        disabled={isPending || !moves.down}
                        data-testid="nextActionPositionDown"
                        title={`Down (${chordLabel(['alt', 'down'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'down' }}
                    >
                        Down
                    </Button>
                    <Button
                        onClick={() => move(moves.bottom)}
                        disabled={isPending || !moves.bottom}
                        data-testid="nextActionPositionBottom"
                        title={`Bottom (${chordLabel(['alt', 'shift', 'down'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'bottom' }}
                    >
                        Bottom
                    </Button>
                    <Button onClick={() => setIsSheetOpen(true)} disabled={isPending || moves.total < 2} data-testid="nextActionPositionMoveTo">
                        Move to…
                    </Button>
                </ButtonGroup>
                <Typography variant="body2" color="text.secondary" aria-live="polite" data-testid="nextActionPositionText">
                    {moves.position} of {moves.total}
                </Typography>
            </Stack>
            {error && <FormHelperText error>{error}</FormHelperText>}
            {/* Keyed per open so a half-finished "Above…" pick and its search never carry over to the next open. */}
            <MoveToSheet
                key={isSheetOpen ? 'open' : 'closed'}
                item={isSheetOpen ? item : null}
                sectionItems={section}
                sectionLabel={label}
                onClose={() => setIsSheetOpen(false)}
                onMove={move}
            />
        </Stack>
    );
}
