import type { IDBPDatabase } from 'idb';
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { reorderItem } from '../../db/itemMutations';
import { Button, ButtonGroup, IconButton, Text } from '../../designSystem';
import { POSITION_MOVE_ATTR } from '../../hooks/useEditorShortcuts';
import { useTodayIso } from '../../hooks/useTodayIso';
import type { NeighbourIds } from '../../lib/dragReorder';
import { daySectionOf, type MoveDirection, moveDirectionOf, positionMoves, positionSectionLabel, sectionOwnerIds } from '../../lib/nextActionPosition';
import { type ChordPart, chordLabel, isApplePlatform } from '../../lib/platformKeys';
import type { MyDB, StoredItem } from '../../types/MyDB';
import { MoveToSheet } from './MoveToSheet';
import styles from './NextActionPositionRow.module.css';

type EdgeOrNudge = 'top' | 'up' | 'down' | 'bottom';

/** The four moves every variant of the row offers, in display order; each names its editor shortcut. */
const MOVE_BUTTONS: ReadonlyArray<{ move: EdgeOrNudge; label: string; chord: readonly ChordPart[]; Icon: typeof ArrowUp; testId: string }> = [
    { move: 'top', label: 'Top', chord: ['alt', 'shift', 'up'], Icon: ArrowUpToLine, testId: 'nextActionPositionTop' },
    { move: 'up', label: 'Up', chord: ['alt', 'up'], Icon: ArrowUp, testId: 'nextActionPositionUp' },
    { move: 'down', label: 'Down', chord: ['alt', 'down'], Icon: ArrowDown, testId: 'nextActionPositionDown' },
    { move: 'bottom', label: 'Bottom', chord: ['alt', 'shift', 'down'], Icon: ArrowDownToLine, testId: 'nextActionPositionBottom' },
];

const LOCKED_HINT = 'Save your changes to reorder';

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
    /** Runs once a move landed AND `item` reflects its new rank — hosts that walk the list (the weekly review) react to the new place. */
    onMoved?: ((direction: MoveDirection) => void) | undefined;
    /**
     * Disables every move. A host whose card can leave the screen on a move (the weekly review
     * hands the walk to the next item) locks the row while structural edits are unsaved — a
     * remount would drop them silently, exactly what its travel-arrow lock already prevents.
     */
    isLocked?: boolean | undefined;
    /**
     * `compact` renders the four moves as icon buttons on one line (no label, no "Move to…", the
     * count read out only) and nothing at all for a one-item section — the weekly-review card
     * runs on a tight vertical budget and hosts the row on its meta line.
     */
    density?: 'default' | 'compact' | undefined;
}

/**
 * The editor's way to raise or lower a next action's priority without leaving it: Top / Up / Down /
 * Bottom within the day the item is saved on, plus "Move to…" for a specific neighbour. Writes
 * through the same `reorderItem` commit as every list gesture; the editor's live merge then adopts
 * the new rank silently (no form field reads it).
 */
export function NextActionPositionRow({ db, item, onBeforeMove, onMoved, isLocked = false, density = 'default' }: Props) {
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
    const isMoveBlocked = isPending || isLocked;
    // `onMoved` fires only once `item` (the host's live row) carries the rank the move wrote —
    // not when `refreshItems()` resolves. The provider swaps its snapshot inside a transition, so a
    // host reacting to the resolved promise would commit its own state FIRST and read the old order.
    const awaitedMoveRef = useRef<{ rank: string; direction: MoveDirection } | null>(null);
    useEffect(() => {
        const awaited = awaitedMoveRef.current;
        if (awaited !== null && item.rank === awaited.rank) {
            awaitedMoveRef.current = null;
            onMoved?.(awaited.direction);
        }
    }, [item.rank, onMoved]);
    if (density === 'compact' && moves.total < 2) {
        return null;
    }

    function move(neighbours: NeighbourIds | null) {
        if (!neighbours) {
            return;
        }
        startTransition(async () => {
            try {
                await onBeforeMove();
                const direction = moveDirectionOf(
                    section.map((row) => row._id),
                    item._id,
                    neighbours,
                );
                const moved = await reorderItem(db, { sectionItems: section, itemId: item._id, ...neighbours, ownerIds: sectionOwnerIds(items, item) });
                if (moved?.rank !== undefined) {
                    awaitedMoveRef.current = { rank: moved.rank, direction };
                    await refreshItems();
                }
                setError(null);
            } catch (err) {
                console.error('[item-editor] reorder failed', err);
                setError('Could not save the new position');
            }
        });
    }

    const moveButtons = MOVE_BUTTONS.map(({ move: edgeOrNudge, label: moveLabel, chord, Icon, testId }) => {
        const shared = {
            onClick: () => move(moves[edgeOrNudge]),
            disabled: isMoveBlocked || !moves[edgeOrNudge],
            'data-testid': testId,
            title: isLocked ? LOCKED_HINT : `${moveLabel} (${chordLabel(chord, isApple)})`,
            [POSITION_MOVE_ATTR]: edgeOrNudge,
        };
        return density === 'compact' ? (
            <IconButton key={edgeOrNudge} size="sm" aria-label={moveLabel} {...shared}>
                <Icon size={16} aria-hidden="true" />
            </IconButton>
        ) : (
            <Button key={edgeOrNudge} size="sm" variant="outline" {...shared}>
                {moveLabel}
            </Button>
        );
    });

    return (
        <div className={styles.row} data-compact={density === 'compact' || undefined} data-locked={isLocked || undefined} data-testid="nextActionPositionRow">
            <Text as="span" variant="caption" tone="secondary" className={density === 'compact' ? 'srOnly' : styles.label}>
                Position in {label}
            </Text>
            <div className={styles.controls}>
                {isLocked && (
                    <Text as="span" variant="caption" tone="secondary" className="srOnly">
                        {LOCKED_HINT}
                    </Text>
                )}
                {/* Each button combines `isMoveBlocked` with its own availability, so the group needs no disabled prop. */}
                <ButtonGroup aria-label="Change position">
                    {moveButtons}
                    {density === 'default' && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setIsSheetOpen(true)}
                            disabled={isMoveBlocked || moves.total < 2}
                            data-testid="nextActionPositionMoveTo"
                        >
                            Move to…
                        </Button>
                    )}
                </ButtonGroup>
                <Text
                    as="span"
                    variant="bodySm"
                    tone="secondary"
                    aria-live="polite"
                    className={density === 'compact' ? 'srOnly' : undefined}
                    data-testid="nextActionPositionText"
                >
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
