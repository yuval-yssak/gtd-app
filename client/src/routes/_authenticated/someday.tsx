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
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import styles from './-someday.module.css';

export const Route = createFileRoute('/_authenticated/someday')({
    component: SomedayPage,
});

function SomedayPage() {
    const { db } = Route.useRouteContext();
    const { items, people, workContexts, routines, refreshItems, isInitialSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });
    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);

    const somedayItems = itemsWithGhosts.filter((item) => item.status === 'somedayMaybe').sort((a, b) => b.createdTs.localeCompare(a.createdTs));

    // Ghosts are fading leftovers, not parked ideas — the header count reflects live rows only.
    const liveSomedayCount = somedayItems.filter((item) => !isGhost(item)).length;

    if (somedayItems.length === 0) {
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
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </Box>
                {/* First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading. */}
                {isInitialSyncing ? (
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
                )}
            </Box>
        );
    }

    return (
        <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                        mb: 3,
                    }}
                >
                    Someday / Maybe
                    {liveSomedayCount > 0 && <Chip label={liveSomedayCount} size="small" className={styles.countChip} />}
                </Typography>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
            </Box>
            <List disablePadding className={styles.list}>
                {somedayItems.map((item, idx) => (
                    <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                        <ListItem
                            disablePadding
                            className={styles.item}
                            secondaryAction={
                                <Box className={styles.actionButtons}>
                                    <CopyIdButton id={item._id} testId="somedayItemCopyIdButton" />
                                    <Tooltip title="Edit">
                                        <IconButton size="small" onClick={() => editor.openEditor({ item })} data-testid="somedayItemEditButton">
                                            <EditIcon fontSize="small" />
                                        </IconButton>
                                    </Tooltip>
                                </Box>
                            }
                        >
                            <ListItemButton onClick={() => editor.openEditor({ item })} className={styles.rowButton} data-testid="somedayItemRow">
                                <ListItemText
                                    primary={
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                            <span>{item.title}</span>
                                            {item.routineId && (
                                                <RoutineIndicator
                                                    routineId={item.routineId}
                                                    routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                                />
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
            </List>
            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
        </Box>
    );
}
