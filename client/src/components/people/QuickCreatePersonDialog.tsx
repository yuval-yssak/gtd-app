import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import type { IDBPDatabase } from 'idb';
import { useState, useTransition } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { createPerson } from '../../db/personMutations';
import type { MyDB, StoredPerson } from '../../types/MyDB';

interface QuickCreatePersonDialogProps {
    open: boolean;
    prefilledEmail: string;
    db: IDBPDatabase<MyDB>;
    /** New person belongs to this owner (the item owner — keeps cross-account references consistent). */
    ownerUserId: string;
    onCreated: (person: StoredPerson) => void;
    onCancel: () => void;
}

/**
 * Minimal "Save as person" modal launched from the meeting-details attendee chip.
 * Two fields only — full edits happen on the People page after creation.
 */
export function QuickCreatePersonDialog({ open, prefilledEmail, db, ownerUserId, onCreated, onCancel }: QuickCreatePersonDialogProps) {
    const { refreshPeople } = useAppData();
    const [name, setName] = useState('');
    const [email, setEmail] = useState(prefilledEmail);
    const [isSaving, startSaving] = useTransition();

    function onSave() {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const trimmedEmail = email.trim();
        startSaving(async () => {
            const fields = trimmedEmail ? { userId: ownerUserId, name: trimmedName, email: trimmedEmail } : { userId: ownerUserId, name: trimmedName };
            const person = await createPerson(db, fields);
            await refreshPeople();
            onCreated(person);
            // Reset so the next launch starts clean if the parent keeps the dialog mounted.
            setName('');
        });
    }

    return (
        <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth data-testid="quickCreatePersonDialog">
            <DialogTitle>Save as person</DialogTitle>
            <DialogContent>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
                    <TextField
                        label="Name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        fullWidth
                        autoFocus
                        required
                        data-testid="quickCreatePersonName"
                    />
                    <TextField
                        label="Email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        fullWidth
                        type="email"
                        data-testid="quickCreatePersonEmail"
                    />
                </Box>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel} disabled={isSaving}>
                    Cancel
                </Button>
                <Button onClick={onSave} variant="contained" disabled={!name.trim() || isSaving} data-testid="quickCreatePersonSave">
                    Save
                </Button>
            </DialogActions>
        </Dialog>
    );
}
