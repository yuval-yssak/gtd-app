import { createFileRoute } from '@tanstack/react-router';
import { CalendarCheck, Pencil } from 'lucide-react';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSkeleton } from '../../components/ListSkeleton';
import { ListRow, ListRowButton, ListRowText } from '../../components/listRow/ListRow';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { useAppData } from '../../contexts/AppDataProvider';
import { releaseFromTickler } from '../../db/itemMutations';
import { Chip, IconButton, Text, Toast, Tooltip } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useTodayIso } from '../../hooks/useTodayIso';
import { SHORTCUT_ROW_PROPS } from '../../lib/rowShortcuts';
import { ticklerDayLabel } from '../../lib/ticklerDayLabel';
import { isTicklerHidden, participatesInTickler } from '../../lib/ticklerVisibility';
import type { StoredItem } from '../../types/MyDB';
import styles from './-tickler.module.css';

export const Route = createFileRoute('/_authenticated/tickler')({
    component: TicklerPage,
});

function TicklerPage() {
    useDocumentTitle('Tickler');
    const { db } = Route.useRouteContext();
    const { items, routines, refreshItems, isInitialSyncing } = useAppData();
    const editor = useItemEditor();
    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);

    // Shared day clock: at local midnight the day's rows drop off the tickler without a reload.
    const today = useTodayIso();
    // ignoreBefore applies to the TICKLER_STATUSES (calendar items ignore it). This page is the
    // ONE place a snoozed item stays reachable — its active list hides it via the same
    // isTicklerHidden predicate — so both sides share the status set and predicate.
    const ticklerItems = itemsWithGhosts
        .filter((item) => participatesInTickler(item) && isTicklerHidden(item, today))
        .sort((a, b) => (a.ignoreBefore ?? '').localeCompare(b.ignoreBefore ?? ''));

    // Ghosts are fading leftovers, not snoozed work — the header count reflects live rows only.
    const liveTicklerCount = ticklerItems.filter((item) => !isGhost(item)).length;

    const groups = ticklerItems.reduce<Record<string, StoredItem[]>>((acc, item) => {
        const key = item.ignoreBefore ?? '';
        acc[key] = [...(acc[key] ?? []), item];
        return acc;
    }, {});

    async function onRelease(item: StoredItem) {
        await releaseFromTickler(db, item);
        await refreshItems();
    }

    const header = (
        <div className={styles.header}>
            <Text variant="title">
                Tickler
                {liveTicklerCount > 0 && <Chip label={liveTicklerCount} className={styles.countChip} />}
            </Text>
            {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
            <AccountSyncChip />
        </div>
    );

    if (ticklerItems.length === 0) {
        return (
            <div>
                {header}
                {/* First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading. */}
                {isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Text tone="secondary" className={styles.emptyMessage}>
                        No items are snoozed. Items hidden with "ignore before" will appear here.
                    </Text>
                )}
            </div>
        );
    }

    return (
        <div>
            {header}
            {Object.entries(groups).map(([dateKey, groupItems]) => (
                <section key={dateKey} className={styles.group}>
                    <Text variant="subtitleSm" tone="secondary" className={styles.groupHeading}>
                        {ticklerDayLabel(dateKey)}
                    </Text>
                    <ul className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <ListRowShell as="li" key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                                <ListRow
                                    {...SHORTCUT_ROW_PROPS}
                                    isDivided={idx < groupItems.length - 1}
                                    actions={
                                        <>
                                            <CopyIdButton isRowAction id={item._id} testId="ticklerItemCopyIdButton" />
                                            <RowActionButton
                                                rowAction="edit"
                                                label="Edit"
                                                icon={<Pencil />}
                                                onClick={(e) => editor.openEditor({ item, event: e })}
                                                data-testid="ticklerItemEditButton"
                                            />
                                            <Tooltip title="Release now">
                                                <IconButton size="sm" aria-label="Release now" onClick={() => void onRelease(item)}>
                                                    <CalendarCheck />
                                                </IconButton>
                                            </Tooltip>
                                        </>
                                    }
                                >
                                    <ListRowButton onActivate={(e) => editor.openEditor({ item, event: e })} data-testid="ticklerItemRow">
                                        <ListRowText
                                            primary={
                                                <>
                                                    <span>{item.title}</span>
                                                    {item.routineId && (
                                                        <RoutineIndicator
                                                            routineId={item.routineId}
                                                            routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                                        />
                                                    )}
                                                    <AccountChip userId={item.userId} />
                                                </>
                                            }
                                            secondary={`Status: ${item.status}`}
                                        />
                                    </ListRowButton>
                                </ListRow>
                            </ListRowShell>
                        ))}
                    </ul>
                </section>
            ))}
            <Toast open={editor.toast.open} autoHideDuration={3000} onClose={editor.closeToast} message={editor.toast.message} />
        </div>
    );
}
