import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { CircleCheck, Pencil } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { WindowVirtualizer } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CalendarRowMeta } from '../../components/CalendarRowMeta';
import { groupCalendarItemsByDay, isMultiDayAllDay, NO_DATE_KEY } from '../../components/calendarRouteSort';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { ListRow, ListRowButton, ListRowText } from '../../components/listRow/ListRow';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { SyncingChip } from '../../components/SyncingChip';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { Chip, IconButton, Text, Toast, Tooltip } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { formatAllDayDate, fromGCalExclusive } from '../../lib/allDayDate';
import { filterItemsByQuery } from '../../lib/itemSearch';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';
import { SHORTCUT_ROW_PROPS } from '../../lib/rowShortcuts';
import type { StoredItem } from '../../types/MyDB';
import styles from './-calendar.module.css';

export const Route = createFileRoute('/_authenticated/calendar')({
    validateSearch: parseListQuerySearch,
    component: CalendarPage,
});

function CalendarPage() {
    useDocumentTitle('Calendar');
    const { db } = Route.useRouteContext();
    const { q } = Route.useSearch();
    const navigate = useNavigate();
    const { items, routines, refreshItems, isInitialSyncing, isCalendarSyncing } = useAppData();
    const editor = useItemEditor();
    useListScrollRestoration();

    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/calendar', search: { q: query || undefined }, replace: true }), [navigate]);
    const search = useListSearch({ urlQuery: q ?? '', writeUrlQuery });
    const { deferredQuery } = search;

    const calendarItems = useMemo(() => items.filter((item) => item.status === 'calendar'), [items]);
    // Group + sort lives in calendarRouteSort.ts so the rules (all-day first, multi-day under start date) are
    // unit-tested independently of this render path. The returned map iterates day-keys chronologically.
    // The in-page query (deferred — see useListSearch) narrows items before grouping, so empty days vanish.
    const groups = useMemo(() => groupCalendarItemsByDay(filterItemsByQuery(calendarItems, deferredQuery)), [calendarItems, deferredQuery]);
    const routineTitleById = useMemo(() => new Map(routines.map((r) => [r._id, r.title])), [routines]);

    function dateLabel(dateKey: string): string {
        if (dateKey === NO_DATE_KEY) {
            return NO_DATE_KEY;
        }
        const d = dayjs(dateKey);
        if (d.isSame(dayjs(), 'day')) {
            return 'Today';
        }
        if (d.isSame(dayjs().add(1, 'day'), 'day')) {
            return 'Tomorrow';
        }
        return d.format('dddd, MMM D');
    }

    const isPast = (dateKey: string) => dateKey !== NO_DATE_KEY && dayjs(dateKey).isBefore(dayjs(), 'day');

    async function onDone(item: StoredItem) {
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
    }

    function renderBody() {
        // First-launch bootstrap: skeleton while IDB loads; "no items" copy only once loaded.
        if (calendarItems.length === 0) {
            return isInitialSyncing ? <ListSkeleton /> : <EmptyMessage text="No upcoming calendar items." />;
        }
        const dayGroups = Object.entries(groups);
        if (dayGroups.length === 0) {
            return <EmptyMessage text="No calendar items match your search." />;
        }
        return (
            // Windowed rendering — only day groups near the viewport mount, so months of calendar
            // history don't block the main thread on navigation. Each day is one measured child.
            <WindowVirtualizer>
                {dayGroups.map(([dateKey, groupItems]) => (
                    <section key={dateKey} className={styles.day}>
                        <div className={styles.dateHeader}>
                            <Text variant="subtitleSm" tone="secondary">
                                {dateLabel(dateKey)}
                            </Text>
                            {isPast(dateKey) && <Chip label="Past" />}
                        </div>
                        <ul className={styles.list}>
                            {groupItems.map((item, idx) => (
                                // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration)
                                <li key={item._id} data-list-item-id={item._id}>
                                    <ListRow
                                        {...SHORTCUT_ROW_PROPS}
                                        isDivided={idx < groupItems.length - 1}
                                        actions={
                                            <>
                                                <CopyIdButton isRowAction id={item._id} testId="calendarItemCopyIdButton" />
                                                <RowActionButton
                                                    rowAction="edit"
                                                    label="Edit"
                                                    icon={<Pencil />}
                                                    onClick={(e) => editor.openEditor({ item, event: e })}
                                                    data-testid="calendarItemEditButton"
                                                />
                                                <Tooltip title="Mark done">
                                                    <IconButton
                                                        size="sm"
                                                        tone="success"
                                                        aria-label="Mark done"
                                                        onClick={() => void onDone(item)}
                                                        data-testid="calendarItemMarkDoneButton"
                                                    >
                                                        <CircleCheck />
                                                    </IconButton>
                                                </Tooltip>
                                            </>
                                        }
                                    >
                                        <ListRowButton
                                            onActivate={(e) => editor.openEditor({ item, event: e })}
                                            className={styles.rowButton}
                                            data-testid="calendarItemRow"
                                        >
                                            <div className={styles.timeCol}>
                                                <TimeColumn item={item} />
                                            </div>
                                            <ListRowText
                                                primary={
                                                    <>
                                                        <span>{item.title}</span>
                                                        {item.routineId && (
                                                            <RoutineIndicator routineId={item.routineId} routineTitle={routineTitleById.get(item.routineId)} />
                                                        )}
                                                        <AccountChip userId={item.userId} />
                                                        <CalendarRowMeta item={item} />
                                                    </>
                                                }
                                            />
                                        </ListRowButton>
                                    </ListRow>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </WindowVirtualizer>
        );
    }

    return (
        <div>
            <div className={styles.header}>
                <Text variant="title">Calendar</Text>
                {isCalendarSyncing && <SyncingChip label="Syncing calendar…" />}
                <AccountSyncChip />
                <ListSearchButton onToggle={search.toggleSearch} testId="calendarSearchButton" />
            </div>
            {search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder="Search calendar…"
                    testId="calendarSearchInput"
                />
            )}
            {renderBody()}
            <Toast open={editor.toast.open} autoHideDuration={3000} onClose={editor.closeToast} message={editor.toast.message} />
        </div>
    );
}

function EmptyMessage({ text }: { text: string }) {
    return (
        <Text tone="secondary" className={styles.emptyMessage}>
            {text}
        </Text>
    );
}

interface TimeColumnProps {
    item: StoredItem;
}

/**
 * Renders the leading time column for a calendar row. Branches on `allDay`:
 * - Multi-day all-day → "All day" chip plus an inclusive date range ("May 27 – May 29"). The
 *   incoming `timeEnd` is GCal-exclusive, so `fromGCalExclusive` converts it back for display.
 * - Single-day all-day → just the chip.
 * - Timed → existing h:mm a (– h:mm a) text.
 */
function TimeColumn({ item }: TimeColumnProps) {
    if (item.allDay) {
        const rangeLabel = buildAllDayRangeLabel(item);
        return (
            <div className={styles.allDay}>
                <Chip label="All day" data-testid="calendarRowAllDayChip" />
                {rangeLabel && (
                    <Text as="span" variant="caption" tone="secondary" data-testid="calendarRowAllDayRange">
                        {rangeLabel}
                    </Text>
                )}
            </div>
        );
    }
    if (!item.timeStart) {
        return null;
    }
    return (
        <Text as="span" variant="caption" tone="secondary">
            {dayjs(item.timeStart).format('h:mm a')}
            {item.timeEnd && ` – ${dayjs(item.timeEnd).format('h:mm a')}`}
        </Text>
    );
}

/** Returns the inclusive-range label for a multi-day all-day item, or undefined for single-day. */
function buildAllDayRangeLabel(item: StoredItem): string | undefined {
    if (!isMultiDayAllDay(item) || !item.timeStart || !item.timeEnd) return undefined;
    const inclusiveEnd = fromGCalExclusive(item.timeEnd);
    return `${formatAllDayDate(item.timeStart)} – ${formatAllDayDate(inclusiveEnd)}`;
}
