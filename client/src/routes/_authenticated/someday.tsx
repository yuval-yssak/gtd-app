import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd';
import EditIcon from '@mui/icons-material/Edit';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useCallback, useMemo } from 'react';
import { WindowVirtualizer } from 'virtua';

dayjs.extend(relativeTime);

import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { filterItemsByQuery, sortItems } from '../../lib/itemSearch';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';
import styles from './-someday.module.css';

export const Route = createFileRoute('/_authenticated/someday')({
    validateSearch: parseListQuerySearch,
    component: SomedayPage,
});

function SomedayPage() {
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

    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;
    const parkedItems = useMemo(() => itemsWithGhosts.filter((item) => item.status === 'somedayMaybe'), [itemsWithGhosts]);
    const somedayItems = useMemo(() => sortItems(filterItemsByQuery(parkedItems, deferredQuery), 'createdTs', 'desc'), [parkedItems, deferredQuery]);

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
            <List disablePadding component="div" className={styles.list}>
                <WindowVirtualizer>
                    {somedayItems.map((item, idx) => (
                        <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box className={styles.actionButtons}>
                                        <CopyIdButton id={item._id} testId="somedayItemCopyIdButton" />
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={(e) => editor.openEditor({ item, event: e })} data-testid="somedayItemEditButton">
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                <ListItemButton
                                    onClick={(e) => editor.openEditor({ item, event: e })}
                                    className={styles.rowButton}
                                    data-testid="somedayItemRow"
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
                            {idx < somedayItems.length - 1 && <Divider />}
                        </ListRowShell>
                    ))}
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
            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
        </Box>
    );
}
