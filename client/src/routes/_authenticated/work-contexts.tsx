import AddIcon from '@mui/icons-material/Add';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountPicker } from '../../components/AccountPicker';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { ListSkeleton } from '../../components/ListSkeleton';
import { WorkContextEditDialog } from '../../components/workContexts/WorkContextEditDialog';
import { useAppData } from '../../contexts/AppDataProvider';
import { createWorkContext, removeWorkContext, updateWorkContext } from '../../db/workContextMutations';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import type { StoredWorkContext } from '../../types/MyDB';
import styles from './-work-contexts.module.css';

export const Route = createFileRoute('/_authenticated/work-contexts')({
    component: WorkContextsPage,
});

function WorkContextsPage() {
    const { db } = Route.useRouteContext();
    const { account, workContexts, refreshWorkContexts, loggedInAccounts, isInitialSyncing } = useAppData();
    const [createOpen, setCreateOpen] = useState(false);
    // Renames autosave inside WorkContextEditDialog (mount-on-open); creation stays an explicit
    // Add action so half-typed names never become synced entities.
    const [editing, setEditing] = useState<StoredWorkContext | null>(null);
    const [nameInput, setNameInput] = useState('');
    const [ownerUserId, setOwnerUserId] = useState<string>('');

    function openCreate() {
        setNameInput('');
        setOwnerUserId(account?.id ?? '');
        setCreateOpen(true);
    }

    async function onCreate() {
        if (!account || !nameInput.trim()) {
            return;
        }
        await createWorkContext(db, { userId: ownerUserId || account.id, name: nameInput.trim() });
        setCreateOpen(false);
        await refreshWorkContexts();
    }

    async function onDelete(ctx: StoredWorkContext) {
        await removeWorkContext(db, ctx._id);
        await refreshWorkContexts();
    }

    // Archive = soft retire: hidden from pickers/filter rows, existing item references stay intact.
    // Unarchive drops the key entirely (exactOptionalPropertyTypes/op-schema style: absent ⇒ active).
    // Re-read from IDB before writing — the render-time row can be stale against a concurrent
    // remote update, and the full LWW snapshot would revert it (e.g. undo a remote rename).
    async function onToggleArchived(ctx: StoredWorkContext) {
        const current = (await db.get('workContexts', ctx._id)) ?? ctx;
        const { archived: _archived, ...active } = current;
        await updateWorkContext(db, current.archived ? active : { ...current, archived: true });
        await refreshWorkContexts();
    }

    // Active contexts first, archived parked at the bottom. The "Unused" hint marks archive
    // candidates: nothing outside the trash references them.
    const usage = useEntityUsage();
    const orderedContexts = useMemo(() => [...workContexts.filter((c) => !c.archived), ...workContexts.filter((c) => c.archived)], [workContexts]);

    return (
        <Box>
            <Box className={styles.pageHeader}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        Work Contexts
                        {workContexts.length > 0 && <Chip label={workContexts.length} size="small" className={styles.countChip} />}
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </Box>
                <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={openCreate}>
                    Add context
                </Button>
            </Box>
            {workContexts.length === 0 ? (
                // First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Typography
                        sx={{
                            color: 'text.secondary',
                            textAlign: 'center',
                            mt: 6,
                        }}
                    >
                        No work contexts yet. Examples: @office, @phone, @computer, @errands.
                    </Typography>
                )
            ) : (
                <List disablePadding className={styles.list}>
                    {orderedContexts.map((ctx, idx) => (
                        <Box key={ctx._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box className={styles.actionButtons}>
                                        <Tooltip title="Rename">
                                            <IconButton size="small" onClick={() => setEditing(ctx)} data-testid="workContextRowEditButton">
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title={ctx.archived ? 'Unarchive' : 'Archive — hide from pickers, keep on items'}>
                                            <IconButton size="small" onClick={() => void onToggleArchived(ctx)} data-testid="workContextRowArchiveButton">
                                                {ctx.archived ? <UnarchiveOutlinedIcon fontSize="small" /> : <ArchiveOutlinedIcon fontSize="small" />}
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Delete">
                                            <IconButton size="small" color="error" onClick={() => void onDelete(ctx)}>
                                                <DeleteOutlineIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                <ListItemText
                                    primary={
                                        <Box
                                            sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                                            className={ctx.archived ? styles.archivedName : undefined}
                                        >
                                            <span>{ctx.name}</span>
                                            <AccountChip userId={ctx.userId} />
                                            {ctx.archived && <Chip label="Archived" size="small" variant="outlined" data-testid="workContextArchivedChip" />}
                                            {!ctx.archived && !usage.contexts.has(ctx._id) && (
                                                <Tooltip title="No item references this context — consider archiving it">
                                                    <Chip label="Unused" size="small" variant="outlined" color="warning" data-testid="workContextUnusedChip" />
                                                </Tooltip>
                                            )}
                                        </Box>
                                    }
                                    className={styles.listItemText}
                                />
                            </ListItem>
                            {idx < orderedContexts.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
            {editing && <WorkContextEditDialog db={db} workContext={editing} onClose={() => setEditing(null)} />}
            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle>Add work context</DialogTitle>
                <DialogContent>
                    <TextField
                        label="Name"
                        placeholder="e.g. @office, @phone"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        fullWidth
                        autoFocus
                        className={styles.nameField}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void onCreate();
                        }}
                    />
                    {/* Auto-hides on single-account devices */}
                    {loggedInAccounts.length > 1 && <AccountPicker value={ownerUserId} onChange={setOwnerUserId} />}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button onClick={() => void onCreate()} variant="contained" disabled={!nameInput.trim()}>
                        Add
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
