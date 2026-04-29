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
import { AccountChip } from '../../components/AccountChip';
import { AccountPicker } from '../../components/AccountPicker';
import { useAppData } from '../../contexts/AppDataProvider';
import { createPerson, removePerson, updatePerson } from '../../db/personMutations';
import { reassignEntity } from '../../db/reassignMutations';
import type { StoredPerson } from '../../types/MyDB';
import styles from './-people.module.css';

export const Route = createFileRoute('/_authenticated/people')({
    component: PeoplePage,
});

interface PersonFormState {
    name: string;
    email: string;
    phone: string;
}

const emptyForm: PersonFormState = { name: '', email: '', phone: '' };

function PeoplePage() {
    const { db } = Route.useRouteContext();
    const { account, people, refreshPeople, loggedInAccounts } = useAppData();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<StoredPerson | null>(null);
    const [form, setForm] = useState<PersonFormState>(emptyForm);
    // Owner of the entity. New persons default to the active account; edits default to the
    // current owner. A change here drives `/sync/reassign` after the local update is saved.
    const [ownerUserId, setOwnerUserId] = useState<string>('');

    function openCreate() {
        setEditing(null);
        setForm(emptyForm);
        setOwnerUserId(account?.id ?? '');
        setDialogOpen(true);
    }

    function openEdit(person: StoredPerson) {
        setEditing(person);
        setForm({ name: person.name, email: person.email ?? '', phone: person.phone ?? '' });
        setOwnerUserId(person.userId);
        setDialogOpen(true);
    }

    async function onSave() {
        if (!account || !form.name.trim()) return;
        if (editing) {
            await saveEdit(editing);
            return;
        }
        await saveCreate();
    }

    /** Persist the form fields locally first, then move ownership server-side if the picker changed. */
    async function saveEdit(target: StoredPerson) {
        const fields = buildPersonFields(target.userId);
        await updatePerson(db, { ...target, ...fields });
        if (ownerUserId !== target.userId) {
            await reassignEntity(db, { entityType: 'person', entityId: target._id, fromUserId: target.userId, toUserId: ownerUserId });
        }
        setDialogOpen(false);
        await refreshPeople();
    }

    async function saveCreate() {
        // New persons always belong to the picked owner — when the user changes the picker for
        // a brand-new entity, we just create it under that owner directly (no reassign needed).
        const ownerForCreate = ownerUserId || account?.id;
        if (!ownerForCreate) {
            return;
        }
        await createPerson(db, buildPersonFields(ownerForCreate));
        setDialogOpen(false);
        await refreshPeople();
    }

    function buildPersonFields(userId: string) {
        return {
            userId,
            name: form.name.trim(),
            ...(form.email.trim() ? { email: form.email.trim() } : {}),
            ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        };
    }

    async function onDelete(person: StoredPerson) {
        await removePerson(db, person._id);
        await refreshPeople();
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                <Typography variant="h5" fontWeight={600}>
                    People
                    {people.length > 0 && <Chip label={people.length} size="small" className={styles.countChip} />}
                </Typography>
                <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={openCreate}>
                    Add person
                </Button>
            </Box>

            {people.length === 0 ? (
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    No people yet. Add contacts to reference in Waiting For and items.
                </Typography>
            ) : (
                <List disablePadding className={styles.list}>
                    {people.map((person, idx) => (
                        <Box key={person._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box className={styles.actionButtons}>
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => openEdit(person)}>
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

            <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle>{editing ? 'Edit person' : 'Add person'}</DialogTitle>
                <DialogContent>
                    <Box className={styles.personForm}>
                        <TextField
                            label="Name"
                            value={form.name}
                            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                            fullWidth
                            autoFocus
                            required
                        />
                        <TextField
                            label="Email"
                            value={form.email}
                            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                            fullWidth
                            type="email"
                        />
                        <TextField label="Phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} fullWidth />
                        {/* AccountPicker auto-hides on single-account devices */}
                        {loggedInAccounts.length > 1 && <AccountPicker value={ownerUserId} onChange={setOwnerUserId} />}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button onClick={() => void onSave()} variant="contained" disabled={!form.name.trim()}>
                        {editing ? 'Save' : 'Add'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
