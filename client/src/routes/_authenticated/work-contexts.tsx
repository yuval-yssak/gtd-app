import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
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
import { useAppData } from '../../contexts/AppDataProvider';
import { createWorkContext, removeWorkContext, updateWorkContext } from '../../db/workContextMutations';
import type { StoredWorkContext } from '../../types/MyDB';
import styles from './work-contexts.module.css';

export const Route = createFileRoute('/_authenticated/work-contexts')({
    component: WorkContextsPage,
});

function WorkContextsPage() {
    const { db } = Route.useRouteContext();
    const { account, workContexts, refreshWorkContexts } = useAppData();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<StoredWorkContext | null>(null);
    const [nameInput, setNameInput] = useState('');

    function openCreate() {
        setEditing(null);
        setNameInput('');
        setDialogOpen(true);
    }

    function openEdit(ctx: StoredWorkContext) {
        setEditing(ctx);
        setNameInput(ctx.name);
        setDialogOpen(true);
    }

    async function onSave() {
        if (!account || !nameInput.trim()) {
            return;
        }
        if (editing) {
            await updateWorkContext(db, { ...editing, name: nameInput.trim() });
        } else {
            await createWorkContext(db, { userId: account.id, name: nameInput.trim() });
        }
        setDialogOpen(false);
        await refreshWorkContexts();
    }

    async function onDelete(ctx: StoredWorkContext) {
        await removeWorkContext(db, ctx._id);
        await refreshWorkContexts();
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                <Typography variant="h5" fontWeight={600}>
                    Work Contexts
                    {workContexts.length > 0 && <Chip label={workContexts.length} size="small" className={styles.countChip} />}
                </Typography>
                <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={openCreate}>
                    Add context
                </Button>
            </Box>

            {workContexts.length === 0 ? (
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    No work contexts yet. Examples: @office, @phone, @computer, @errands.
                </Typography>
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
                                            <IconButton size="small" onClick={() => openEdit(ctx)}>
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
                                <ListItemText primary={ctx.name} className={styles.listItemText} />
                            </ListItem>
                            {idx < workContexts.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}

            <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle>{editing ? 'Rename context' : 'Add work context'}</DialogTitle>
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
                            if (e.key === 'Enter') void onSave();
                        }}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button onClick={() => void onSave()} variant="contained" disabled={!nameInput.trim()}>
                        {editing ? 'Save' : 'Add'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
