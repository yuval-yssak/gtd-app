import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useCallback, useMemo } from 'react';
import { WindowVirtualizer } from 'virtua';
import { RankedListChrome } from '../../components/rankedList/RankedListChrome';
import { RankedRowHandle } from '../../components/rankedList/RankedRowHandle';
import { rankedRowButtonProps, rankedRowProps } from '../../components/rankedList/rankedRowProps';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useRankedList } from '../../hooks/useRankedList';
import { flatSection, itemRows } from '../../lib/nextActionSections';
import { ownerIdsOfStatus } from '../../lib/rankSections';
import { RANKED_LIST_ROW_ACTIONS } from '../../lib/rowShortcuts';

dayjs.extend(relativeTime);

import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { useAppData } from '../../contexts/AppDataProvider';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { useTodayIso } from '../../hooks/useTodayIso';
import { compareByRank } from '../../lib/compareNextActions';
import { filterItemsByQuery } from '../../lib/itemSearch';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';
import { isTicklerHidden } from '../../lib/ticklerVisibility';
import styles from './-someday.module.css';

export const Route = createFileRoute('/_authenticated/someday')({
    validateSearch: parseListQuerySearch,
    component: SomedayPage,
});

function SomedayPage() {
    useDocumentTitle('Someday / Maybe');
    const { db } = Route.useRouteContext();
    const { q } = Route.useSearch();
    const navigate = useNavigate();
    const { items, people, workContexts, routines, refreshItems, isInitialSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });
    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);

    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/someday', search: { q: query || undefined }, replace: true }), [navigate]);
    const search = useListSearch({ urlQuery: q ?? '', writeUrlQuery });

    // Shared day clock so a snoozed item surfaces here at local midnight without a reload.
    const todayIso = useTodayIso();

    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;
    // Tickler pattern: a snoozed somedayMaybe item lives on /tickler alone until its date —
    // previously this page never filtered on ignoreBefore, contradicting docs/DATA_MODEL.md.
    const parkedItems = useMemo(
        () => itemsWithGhosts.filter((item) => item.status === 'somedayMaybe' && !isTicklerHidden(item, todayIso)),
        [itemsWithGhosts, todayIso],
    );
    // The manual order (`rank`; untouched it stays newest-first, as a fresh item is minted at the top).
    const somedayItems = useMemo(() => [...filterItemsByQuery(parkedItems, deferredQuery)].sort(compareByRank), [parkedItems, deferredQuery]);
    // One section, no header: all of Someday / Maybe is one manual order (see lib/rankSections).
    const somedaySections = useMemo(() => [flatSection('somedayMaybe', 'Someday / Maybe', somedayItems)], [somedayItems]);
    // Every account of the merged list (visible rows or not) shares the keyspace a re-key must see.
    const somedayOwnerIds = useMemo(() => ownerIdsOfStatus(items, 'somedayMaybe'), [items]);
    const ranked = useRankedList({
        db,
        sections: somedaySections,
        isGhost,
        ownerIds: somedayOwnerIds,
        refreshItems,
        hasHeaders: false,
        regionLabel: 'Someday / Maybe',
    });

    // Lookup map so each row doesn't rescan the routines array for its indicator title.
    const routineTitleById = useMemo(() => new Map(routines.map((r) => [r._id, r.title])), [routines]);

    // Ghosts are fading leftovers, not parked ideas — the header count reflects live rows only.
    const liveSomedayCount = somedayItems.filter((item) => !isGhost(item)).length;

    function renderBody() {
        // First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading.
        if (parkedItems.length === 0) {
            return isInitialSyncing ? (
                <ListSkeleton />
            ) : (
                <Paper variant="outlined" className={styles.emptyCard}>
                    <BookmarkAddIcon className={styles.icon} />
                    <Typography
                        variant="subtitle1"
                        sx={{
                            fontWeight: 600,
                            mb: 1,
                        }}
                    >
                        Nothing parked yet
                    </Typography>
                    <Typography
                        variant="body2"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Move items here from the edit dialog when you want to hold onto an idea without committing to it.
                    </Typography>
                </Paper>
            );
        }
        if (somedayItems.length === 0) {
            return (
                <Typography
                    sx={{
                        color: 'text.secondary',
                        textAlign: 'center',
                        mt: 6,
                    }}
                >
                    No parked items match your search.
                </Typography>
            );
        }
        return (
            // component="div": WindowVirtualizer renders a measuring <div> wrapper, invalid inside
            // the default <ul>. Windowed rendering — only rows near the viewport mount, so a large
            // someday/maybe backlog doesn't block the main thread on navigation.
            // One tab stop for the whole list (see useNextActionsRovingFocus).
            <List
                disablePadding
                component="div"
                role="list"
                className={styles.list}
                aria-label="Someday / Maybe"
                aria-describedby={ranked.hintIds.list}
                data-testid="somedayList"
                {...ranked.roving.listProps}
            >
                <WindowVirtualizer ref={ranked.virtualizerRef}>
                    {itemRows(ranked.flatRows).map((row) => {
                        const { item, section, isLastInSection } = row;
                        return (
                            <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                                <ListItem
                                    disablePadding
                                    {...rankedRowProps(ranked, row, styles.item)}
                                    secondaryAction={
                                        <Box className={styles.actionButtons}>
                                            {/* Everything but Copy id is hidden on a ghost: it is a stale snapshot of a row that already left the list. */}
                                            {!isGhost(item) && (
                                                <RowActionButton
                                                    rowAction="moveTo"
                                                    label="Move to…"
                                                    icon={<MoreVertIcon fontSize="small" />}
                                                    onClick={() => ranked.openMoveTo(item, section)}
                                                    data-testid="somedayItemMoveToButton"
                                                    {...ranked.roving.actionButtonProps}
                                                />
                                            )}
                                            <CopyIdButton
                                                isRowAction
                                                id={item._id}
                                                testId="somedayItemCopyIdButton"
                                                buttonProps={ranked.roving.actionButtonProps}
                                            />
                                            {!isGhost(item) && (
                                                <RowActionButton
                                                    rowAction="edit"
                                                    label="Edit"
                                                    icon={<EditIcon fontSize="small" />}
                                                    size="small"
                                                    onClick={(e) => editor.openEditor({ item, event: e })}
                                                    data-testid="somedayItemEditButton"
                                                    {...ranked.roving.actionButtonProps}
                                                />
                                            )}
                                        </Box>
                                    }
                                >
                                    {!isGhost(item) && <RankedRowHandle ranked={ranked} item={item} section={section} testId="somedayDragHandle" />}
                                    <ListItemButton
                                        onClick={(e) => editor.openEditor({ item, event: e })}
                                        className={styles.rowButton}
                                        data-testid="somedayItemRow"
                                        {...rankedRowButtonProps(ranked)}
                                    >
                                        <ListItemText
                                            primary={
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                    <span>{item.title}</span>
                                                    {item.routineId && (
                                                        <RoutineIndicator routineId={item.routineId} routineTitle={routineTitleById.get(item.routineId)} />
                                                    )}
                                                    <AccountChip userId={item.userId} />
                                                </Box>
                                            }
                                            secondary={dayjs(item.createdTs).fromNow()}
                                        />
                                    </ListItemButton>
                                </ListItem>
                                {editor.renderExpandFor(item._id)}
                                {!isLastInSection && <Divider />}
                            </ListRowShell>
                        );
                    })}
                </WindowVirtualizer>
            </List>
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
                    Someday / Maybe
                    {liveSomedayCount > 0 && <Chip label={liveSomedayCount} size="small" className={styles.countChip} />}
                </Typography>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
                {/* Hidden while the archive is truly empty — same convention as done/trash. */}
                {parkedItems.length > 0 && <ListSearchButton onToggle={search.toggleSearch} testId="somedaySearchButton" />}
            </Box>
            {parkedItems.length > 0 && search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder="Search someday / maybe…"
                    testId="somedaySearchInput"
                />
            )}
            {renderBody()}
            {/* Keyboard hints, the reorder announcer, the failure toast and the Move to sheet. */}
            <RankedListChrome ranked={ranked} actions={RANKED_LIST_ROW_ACTIONS} sectionNoun="list" liveTestId="somedayReorderLive" />
            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
        </Box>
    );
}
