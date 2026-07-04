import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
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
import { useState } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountPicker } from '../../components/AccountPicker';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { ListSkeleton } from '../../components/ListSkeleton';
import { WorkContextEditDialog } from '../../components/workContexts/WorkContextEditDialog';
import { useAppData } from '../../contexts/AppDataProvider';
import { createWorkContext, removeWorkContext } from '../../db/workContextMutations';
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
                    {workContexts.map((ctx, idx) => (
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
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                            <span>{ctx.name}</span>
                                            <AccountChip userId={ctx.userId} />
                                        </Box>
                                    }
                                    className={styles.listItemText}
                                />
                            </ListItem>
                            {idx < workContexts.length - 1 && <Divider />}
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
