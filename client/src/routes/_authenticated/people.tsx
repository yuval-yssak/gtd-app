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
import { createPerson, removePerson, updatePerson } from '../../db/personMutations';
import type { StoredPerson } from '../../types/MyDB';
import styles from './people.module.css';

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
    const { account, people, refreshPeople } = useAppData();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<StoredPerson | null>(null);
    const [form, setForm] = useState<PersonFormState>(emptyForm);

    function openCreate() {
        setEditing(null);
        setForm(emptyForm);
        setDialogOpen(true);
    }

    function openEdit(person: StoredPerson) {
        setEditing(person);
        setForm({ name: person.name, email: person.email ?? '', phone: person.phone ?? '' });
        setDialogOpen(true);
    }

    async function onSave() {
        if (!account || !form.name.trim()) return;
        const fields = {
            userId: account.id,
            name: form.name.trim(),
            ...(form.email.trim() ? { email: form.email.trim() } : {}),
            ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        };
        if (editing) {
            await updatePerson(db, { ...editing, ...fields });
        } else {
            await createPerson(db, fields);
        }
        setDialogOpen(false);
        await refreshPeople();
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
                                    primary={person.name}
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
