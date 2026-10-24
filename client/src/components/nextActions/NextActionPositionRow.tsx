import type { IDBPDatabase } from 'idb';
import { useMemo, useState, useTransition } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { reorderItem } from '../../db/itemMutations';
import { Button, ButtonGroup, Text } from '../../designSystem';
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
        <div className={styles.row} data-testid="nextActionPositionRow">
            <Text as="span" variant="caption" tone="secondary" className={styles.label}>
                Position in {label}
            </Text>
            <div className={styles.controls}>
                {/* Each button combines `isPending` with its own availability, so the group needs no disabled prop. */}
                <ButtonGroup aria-label="Change position">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => move(moves.top)}
                        disabled={isPending || !moves.top}
                        data-testid="nextActionPositionTop"
                        title={`Top (${chordLabel(['alt', 'shift', 'up'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'top' }}
                    >
                        Top
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => move(moves.up)}
                        disabled={isPending || !moves.up}
                        data-testid="nextActionPositionUp"
                        title={`Up (${chordLabel(['alt', 'up'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'up' }}
                    >
                        Up
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => move(moves.down)}
                        disabled={isPending || !moves.down}
                        data-testid="nextActionPositionDown"
                        title={`Down (${chordLabel(['alt', 'down'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'down' }}
                    >
                        Down
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => move(moves.bottom)}
                        disabled={isPending || !moves.bottom}
                        data-testid="nextActionPositionBottom"
                        title={`Bottom (${chordLabel(['alt', 'shift', 'down'], isApple)})`}
                        {...{ [POSITION_MOVE_ATTR]: 'bottom' }}
                    >
                        Bottom
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setIsSheetOpen(true)}
                        disabled={isPending || moves.total < 2}
                        data-testid="nextActionPositionMoveTo"
                    >
                        Move to…
                    </Button>
                </ButtonGroup>
                <Text as="span" variant="bodySm" tone="secondary" aria-live="polite" data-testid="nextActionPositionText">
                    {moves.position} of {moves.total}
                </Text>
            </div>
            {error && (
                <Text as="span" variant="caption" tone="error" role="alert">
                    {error}
                </Text>
            )}
            {/* Keyed per open so a half-finished "Above…" pick and its search never carry over to the next open. */}
            <MoveToSheet
                key={isSheetOpen ? 'open' : 'closed'}
                item={isSheetOpen ? item : null}
                sectionItems={section}
                sectionLabel={label}
                onClose={() => setIsSheetOpen(false)}
                onMove={move}
            />
        </div>
    );
}
