import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { CircleCheck, EllipsisVertical, Pencil } from 'lucide-react';
import { useMemo } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListEmptyMessage } from '../../components/ListEmptyMessage';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSkeleton } from '../../components/ListSkeleton';
import { ListRow, ListRowButton, ListRowText } from '../../components/listRow/ListRow';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { RankedListChrome } from '../../components/rankedList/RankedListChrome';
import { RankedRowHandle } from '../../components/rankedList/RankedRowHandle';
import { rankedHeaderProps, rankedRowButtonProps, rankedRowProps } from '../../components/rankedList/rankedRowProps';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { Chip, IconButton, Text, Toast, ToggleGroup, Tooltip } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useRankedList } from '../../hooks/useRankedList';
import { useTodayIso } from '../../hooks/useTodayIso';
import { groupIntoSections, type NextActionSection } from '../../lib/nextActionSections';
import { ownerIdsOfStatus } from '../../lib/rankSections';
import { RANKED_LIST_ROW_ACTIONS, SHORTCUT_ROW_PROPS } from '../../lib/rowShortcuts';
import { isTicklerHidden } from '../../lib/ticklerVisibility';
import {
    compareWaitingForByExpectedBy,
    groupByWaitingForPerson,
    personNameMap,
    resolvePersonName,
    sortGroupEntriesByPersonName,
    UNASSIGNED_GROUP_KEY,
} from '../../lib/waitingForGroups';
import { parseWaitingForSearch } from '../../lib/waitingForUrlParams';
import type { StoredItem } from '../../types/MyDB';
import styles from './-waiting-for.module.css';

const SORT_OPTIONS = [
    { value: 'person', label: 'Person', 'aria-label': 'Sort by person', 'data-testid': 'waitingForSortByPerson' },
    { value: 'date', label: 'Date', 'aria-label': 'Sort by date', 'data-testid': 'waitingForSortByDate' },
] as const;

export const Route = createFileRoute('/_authenticated/waiting-for')({
    component: WaitingForPage,
    validateSearch: parseWaitingForSearch,
});

function WaitingForPage() {
    useDocumentTitle('Waiting For');
    const { db } = Route.useRouteContext();
    const { sortBy = 'person' } = Route.useSearch();
    const navigate = useNavigate();
    const { items, allPeople, routines, refreshItems, isInitialSyncing } = useAppData();
    const editor = useItemEditor();
    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);
    // Shared day clock so the overdue highlight rolls at local midnight without a reload.
    const todayIso = useTodayIso();

    const waitingItems = useMemo(
        () =>
            itemsWithGhosts
                // Tickler pattern: a snoozed waitingFor item lives on /tickler alone until its date —
                // previously it double-listed here, contradicting docs/DATA_MODEL.md.
                .filter((item) => item.status === 'waitingFor' && !isTicklerHidden(item, todayIso))
                .sort(compareWaitingForByExpectedBy),
        [itemsWithGhosts, todayIso],
    );

    // Ghosts are fading leftovers, not open work — the header count reflects live rows only.
    const liveWaitingCount = waitingItems.filter((item) => !isGhost(item)).length;

    // Unfiltered allPeople: see personNameMap — hidden accounts' names must still resolve.
    const personMap = personNameMap(allPeople);

    // Group by person (or "Unassigned"), then order the groups A→Z by resolved name —
    // "Unassigned" sorts last since it isn't a real name.
    const groups = groupByWaitingForPerson(waitingItems);
    const sortedGroupEntries = sortGroupEntriesByPersonName(groups, personMap);

    function onSortByChanged(value: 'person' | 'date') {
        void navigate({ to: '/waiting-for', search: { sortBy: value === 'person' ? undefined : value }, replace: true });
    }

    // `ranked` is declared below; this runs on a click, long after the render that declared it.
    async function onReceived(item: StoredItem) {
        const handOff = ranked.focusHandOffFrom(item._id);
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
        handOff();
    }

    const isOverdue = (item: StoredItem) => item.expectedBy !== undefined && item.expectedBy < todayIso;

    // "By date": one section per expected day ("No date" first, as the comparator orders it), the
    // manual order (`rank`) inside each day. "By person" has no manual order of its own yet.
    const dateSections = useMemo(() => groupIntoSections(waitingItems, todayIso), [waitingItems, todayIso]);
    // Every account of the merged list (visible rows or not) shares the keyspace a re-key must see.
    const waitingOwnerIds = useMemo(() => ownerIdsOfStatus(items, 'waitingFor'), [items]);
    const ranked = useRankedList({ db, sections: dateSections, isGhost, ownerIds: waitingOwnerIds, refreshItems, regionLabel: 'Waiting for' });

    /** One row; `section` makes it a ranked row of the "By date" list (drag handle, roving focus, Move to). */
    function renderRow(item: StoredItem, isLast: boolean, section?: NextActionSection<StoredItem>) {
        const rowProps = section ? rankedRowProps(ranked, { kind: 'item', item, section, isLastInSection: isLast }) : SHORTCUT_ROW_PROPS;
        const buttonProps = section ? ranked.roving.actionButtonProps : {};
        return (
            // A list item of the "By person" <ul>; the "By date" list is a flat run of headers and rows.
            <ListRowShell as={section ? 'div' : 'li'} key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                <ListRow
                    {...rowProps}
                    isDivided={!isLast}
                    actions={
                        <>
                            {section && !isGhost(item) && (
                                <RowActionButton
                                    rowAction="moveTo"
                                    label="Move to…"
                                    icon={<EllipsisVertical />}
                                    onClick={() => ranked.openMoveTo(item, section)}
                                    data-testid="waitingForItemMoveToButton"
                                    {...buttonProps}
                                />
                            )}
                            <CopyIdButton isRowAction id={item._id} testId="waitingForItemCopyIdButton" buttonProps={buttonProps} />
                            {/* Everything but Copy id is hidden on a ghost: Received on its stale snapshot (even by keyboard) would act twice. */}
                            {!isGhost(item) && (
                                <>
                                    <RowActionButton
                                        rowAction="edit"
                                        label="Edit"
                                        icon={<Pencil />}
                                        onClick={(e) => editor.openEditor({ item, event: e })}
                                        data-testid="waitingForItemEditButton"
                                        {...buttonProps}
                                    />
                                    <Tooltip title="Received">
                                        <IconButton size="sm" tone="success" aria-label="Received" onClick={() => void onReceived(item)} {...buttonProps}>
                                            <CircleCheck />
                                        </IconButton>
                                    </Tooltip>
                                </>
                            )}
                        </>
                    }
                >
                    {section && !isGhost(item) && <RankedRowHandle ranked={ranked} item={item} section={section} testId="waitingForDragHandle" />}
                    <ListRowButton
                        onActivate={(e) => editor.openEditor({ item, event: e })}
                        data-testid="waitingForItemRow"
                        {...(section ? rankedRowButtonProps(ranked) : {})}
                    >
                        <ListRowText
                            primary={
                                <>
                                    <span>{item.title}</span>
                                    {item.routineId && (
                                        <RoutineIndicator routineId={item.routineId} routineTitle={routines.find((r) => r._id === item.routineId)?.title} />
                                    )}
                                    {/* By-date view flattens the person groups, so surface who's owed on each row. */}
                                    {sortBy === 'date' && item.waitingForPersonId && (
                                        <Chip
                                            variant="outline"
                                            label={resolvePersonName(personMap, item.waitingForPersonId)}
                                            data-testid="waitingForPersonChip"
                                        />
                                    )}
                                    <AccountChip userId={item.userId} />
                                </>
                            }
                            secondary={
                                item.expectedBy ? (
                                    <Text as="span" variant="caption" tone={isOverdue(item) ? 'error' : 'secondary'}>
                                        Expected by {dayjs(item.expectedBy).format('MMM D')}
                                        {isOverdue(item) && ' — overdue'}
                                    </Text>
                                ) : undefined
                            }
                        />
                    </ListRowButton>
                </ListRow>
            </ListRowShell>
        );
    }

    /** The "By date" view: day sections with headers, one tab stop (see useNextActionsRovingFocus). */
    function renderDateList() {
        return (
            // Day headers interleave with the rows, so this is a named section of headers and rows rather
            // than a <ul>; it is the list's one tab stop.
            <section
                className={styles.list}
                aria-label="Waiting for, by date"
                aria-describedby={ranked.hintIds.list}
                data-testid="waitingForDateList"
                {...ranked.roving.listProps}
            >
                {ranked.flatRows.map((row) =>
                    row.kind === 'header' ? (
                        <Text
                            key={`header-${row.section.key}`}
                            variant="subtitleSm"
                            {...rankedHeaderProps(ranked, row.section)}
                            data-testid="waitingForSectionHeader"
                        >
                            {row.section.label}
                        </Text>
                    ) : (
                        renderRow(row.item, row.isLastInSection, row.section)
                    ),
                )}
            </section>
        );
    }

    function renderItemList(rowItems: StoredItem[]) {
        return <ul className={styles.list}>{rowItems.map((item, idx) => renderRow(item, idx === rowItems.length - 1))}</ul>;
    }

    if (waitingItems.length === 0) {
        return (
            <div>
                <ListPageHeader title="Waiting For">
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </ListPageHeader>
                {/* First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading. */}
                {isInitialSyncing ? <ListSkeleton /> : <ListEmptyMessage>Nothing pending.</ListEmptyMessage>}
            </div>
        );
    }

    return (
        <div>
            <ListPageHeader title="Waiting For" count={liveWaitingCount} countTone="accent">
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
            </ListPageHeader>
            <div className={styles.sortRow}>
                <ToggleGroup value={sortBy} onValueChange={onSortByChanged} aria-label="Sort waiting-for items" options={SORT_OPTIONS} />
            </div>
            {sortBy === 'date'
                ? renderDateList()
                : sortedGroupEntries.map(([personId, groupItems]) => (
                      <section key={personId} className={styles.group}>
                          <Text variant="subtitleSm" tone="secondary" className={styles.groupHeading}>
                              {personId === UNASSIGNED_GROUP_KEY ? 'Unassigned' : resolvePersonName(personMap, personId)}
                          </Text>
                          {renderItemList(groupItems)}
                      </section>
                  ))}
            {/* Keyboard hints, the reorder announcer, the failure toast and the Move to sheet ("By date"). */}
            <RankedListChrome ranked={ranked} actions={RANKED_LIST_ROW_ACTIONS} sectionNoun="day" liveTestId="waitingForReorderLive" />
            <Toast open={editor.toast.open} autoHideDuration={3000} onClose={editor.closeToast} message={editor.toast.message} />
        </div>
    );
}
