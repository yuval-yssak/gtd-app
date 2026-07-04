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
import { PersonEditDialog } from '../../components/people/PersonEditDialog';
import { useAppData } from '../../contexts/AppDataProvider';
import { createPerson, removePerson } from '../../db/personMutations';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import type { StoredPerson } from '../../types/MyDB';
import styles from './-people.module.css';

export const Route = createFileRoute('/_authenticated/people')({
    component: PeoplePage,
});

interface CreateFormState {
    name: string;
    email: string;
    phone: string;
}

const emptyForm: CreateFormState = { name: '', email: '', phone: '' };

function PeoplePage() {
    const { db } = Route.useRouteContext();
    useListScrollRestoration();
    const { account, people, refreshPeople, loggedInAccounts, isInitialSyncing } = useAppData();
    const [createOpen, setCreateOpen] = useState(false);
    const [editing, setEditing] = useState<StoredPerson | null>(null);
    const [createForm, setCreateForm] = useState<CreateFormState>(emptyForm);
    // Owner of the entity for create flow. Edit flow lives inside PersonEditDialog (which has its own picker).
    const [createOwnerUserId, setCreateOwnerUserId] = useState<string>('');

    function openCreate() {
        setCreateForm(emptyForm);
        setCreateOwnerUserId(account?.id ?? '');
        setCreateOpen(true);
    }

    async function saveCreate() {
        if (!account || !createForm.name.trim()) return;
        const ownerForCreate = createOwnerUserId || account.id;
        await createPerson(db, {
            userId: ownerForCreate,
            name: createForm.name.trim(),
            ...(createForm.email.trim() ? { email: createForm.email.trim() } : {}),
            ...(createForm.phone.trim() ? { phone: createForm.phone.trim() } : {}),
        });
        setCreateOpen(false);
        await refreshPeople();
    }

    async function onDelete(person: StoredPerson) {
        await removePerson(db, person._id);
        await refreshPeople();
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
                        People
                        {people.length > 0 && <Chip label={people.length} size="small" className={styles.countChip} />}
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </Box>
                <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={openCreate}>
                    Add person
                </Button>
            </Box>
            {people.length === 0 ? (
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
                        No people yet. Add contacts to reference in Waiting For and items.
                    </Typography>
                )
            ) : (
                <List disablePadding className={styles.list}>
                    {people.map((person, idx) => (
                        // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration)
                        <Box key={person._id} data-list-item-id={person._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box className={styles.actionButtons}>
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => setEditing(person)} data-testid="personRowEditButton">
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Delete">
                                            <IconButton size="small" color="error" onClick={() => void onDelete(person)}>
                                                <DeleteOutlineIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                <ListItemText
                                    primary={
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                            <span>{person.name}</span>
                                            <AccountChip userId={person.userId} />
                                        </Box>
                                    }
                                    secondary={[person.email, person.phone].filter(Boolean).join(' · ') || undefined}
                                    className={styles.listItemText}
                                />
                            </ListItem>
                            {idx < people.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
            {/* Edit dialog reuses the shared PersonEditDialog component (also used by MeetingDetails).
                Mount-on-open so the form re-initializes per person — see PersonEditDialog comment. */}
            {editing && <PersonEditDialog db={db} person={editing} showAccountPicker onClose={() => setEditing(null)} />}
            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle>Add person</DialogTitle>
                <DialogContent>
                    <Box className={styles.personForm}>
                        <TextField
                            label="Name"
                            value={createForm.name}
                            onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                            fullWidth
                            autoFocus
                            required
                        />
                        <TextField
                            label="Email"
                            value={createForm.email}
                            onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                            fullWidth
                            type="email"
                        />
                        <TextField label="Phone" value={createForm.phone} onChange={(e) => setCreateForm((f) => ({ ...f, phone: e.target.value }))} fullWidth />
                        {/* AccountPicker auto-hides on single-account devices */}
                        {loggedInAccounts.length > 1 && <AccountPicker value={createOwnerUserId} onChange={setCreateOwnerUserId} />}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button onClick={() => void saveCreate()} variant="contained" disabled={!createForm.name.trim()}>
                        Add
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
