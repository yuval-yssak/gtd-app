import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { RankedListChrome } from '../../components/rankedList/RankedListChrome';
import { RankedRowHandle } from '../../components/rankedList/RankedRowHandle';
import { rankedHeaderClassName, rankedRowButtonProps, rankedRowProps } from '../../components/rankedList/rankedRowProps';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
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

    function onSortByChanged(value: 'person' | 'date' | null) {
        if (!value) return;
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
        const rowProps = section
            ? rankedRowProps(ranked, { kind: 'item', item, section, isLastInSection: isLast }, styles.item)
            : { ...SHORTCUT_ROW_PROPS, className: styles.item };
        const buttonProps = section ? ranked.roving.actionButtonProps : {};
        return (
            <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                <ListItem
                    disablePadding
                    {...rowProps}
                    secondaryAction={
                        <Box className={styles.actionButtons}>
                            {section && !isGhost(item) && (
                                <RowActionButton
                                    rowAction="moveTo"
                                    label="Move to…"
                                    icon={<MoreVertIcon fontSize="small" />}
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
                                        icon={<EditIcon fontSize="small" />}
                                        onClick={(e) => editor.openEditor({ item, event: e })}
                                        data-testid="waitingForItemEditButton"
                                        {...buttonProps}
                                    />
                                    <Tooltip title="Received">
                                        <IconButton size="small" color="success" onClick={() => void onReceived(item)} {...buttonProps}>
                                            <CheckCircleOutlineIcon />
                                        </IconButton>
                                    </Tooltip>
                                </>
                            )}
                        </Box>
                    }
                >
                    {section && !isGhost(item) && <RankedRowHandle ranked={ranked} item={item} section={section} testId="waitingForDragHandle" />}
                    <ListItemButton
                        onClick={(e) => editor.openEditor({ item, event: e })}
                        className={styles.rowButton}
                        data-testid="waitingForItemRow"
                        {...(section ? rankedRowButtonProps(ranked) : {})}
                    >
                        <ListItemText
                            primary={
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    <span>{item.title}</span>
                                    {item.routineId && (
                                        <RoutineIndicator routineId={item.routineId} routineTitle={routines.find((r) => r._id === item.routineId)?.title} />
                                    )}
                                    {/* By-date view flattens the person groups, so surface who's owed on each row. */}
                                    {sortBy === 'date' && item.waitingForPersonId && (
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            label={resolvePersonName(personMap, item.waitingForPersonId)}
                                            data-testid="waitingForPersonChip"
                                        />
                                    )}
                                    <AccountChip userId={item.userId} />
                                </Box>
                            }
                            secondary={
                                item.expectedBy ? (
                                    <Typography component="span" variant="caption" color={isOverdue(item) ? 'error' : 'text.secondary'}>
                                        Expected by {dayjs(item.expectedBy).format('MMM D')}
                                        {isOverdue(item) && ' — overdue'}
                                    </Typography>
                                ) : undefined
                            }
                            className={styles.listItemText}
                        />
                    </ListItemButton>
                </ListItem>
                {!isLast && <Divider />}
            </ListRowShell>
        );
    }

    /** The "By date" view: day sections with headers, one tab stop (see useNextActionsRovingFocus). */
    function renderDateList() {
        return (
            <List
                disablePadding
                component="div"
                role="list"
                className={styles.list}
                aria-label="Waiting for, by date"
                aria-describedby={ranked.hintIds.list}
                data-testid="waitingForDateList"
                {...ranked.roving.listProps}
            >
                {ranked.flatRows.map((row) =>
                    row.kind === 'header' ? (
                        <Typography
                            key={`header-${row.section.key}`}
                            component="div"
                            variant="subtitle2"
                            className={rankedHeaderClassName(ranked, row.section)}
                            data-testid="waitingForSectionHeader"
                        >
                            {row.section.label}
                        </Typography>
                    ) : (
                        renderRow(row.item, row.isLastInSection, row.section)
                    ),
                )}
            </List>
        );
    }

    function renderItemList(rowItems: StoredItem[]) {
        return (
            <List disablePadding className={styles.list}>
                {rowItems.map((item, idx) => renderRow(item, idx === rowItems.length - 1))}
            </List>
        );
    }

    if (waitingItems.length === 0) {
        return (
            <Box>
                {/* mb on the wrapper (not the Typography) so the chip stays vertically centered with the title. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        Waiting For
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </Box>
                {/* First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading. */}
                {isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Typography
                        sx={{
                            color: 'text.secondary',
                            textAlign: 'center',
                            mt: 6,
                        }}
                    >
                        Nothing pending.
                    </Typography>
                )}
            </Box>
        );
    }

    return (
        <Box>
            {/* mb on the wrapper (not the Typography) so the chip stays vertically centered with the title. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    Waiting For
                    {liveWaitingCount > 0 && <Chip label={liveWaitingCount} size="small" color="primary" className={styles.countChip} />}
                </Typography>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
                <ToggleButtonGroup size="small" value={sortBy} exclusive onChange={(_, value: 'person' | 'date' | null) => onSortByChanged(value)}>
                    <ToggleButton value="person" aria-label="Sort by person" data-testid="waitingForSortByPerson">
                        Person
                    </ToggleButton>
                    <ToggleButton value="date" aria-label="Sort by date" data-testid="waitingForSortByDate">
                        Date
                    </ToggleButton>
                </ToggleButtonGroup>
            </Box>
            {sortBy === 'date'
                ? renderDateList()
                : sortedGroupEntries.map(([personId, groupItems]) => (
                      <Box
                          key={personId}
                          sx={{
                              mb: 3,
                          }}
                      >
                          <Typography
                              variant="subtitle2"
                              sx={{
                                  color: 'text.secondary',
                                  fontWeight: 600,
                                  mb: 1,
                              }}
                          >
                              {personId === UNASSIGNED_GROUP_KEY ? 'Unassigned' : resolvePersonName(personMap, personId)}
                          </Typography>
                          {renderItemList(groupItems)}
                      </Box>
                  ))}
            {/* Keyboard hints, the reorder announcer, the failure toast and the Move to sheet ("By date"). */}
            <RankedListChrome ranked={ranked} actions={RANKED_LIST_ROW_ACTIONS} sectionNoun="day" liveTestId="waitingForReorderLive" />
            <Snackbar open={editor.toast.open} autoHideDuration={3000} onClose={editor.closeToast} message={editor.toast.message} />
        </Box>
    );
}
