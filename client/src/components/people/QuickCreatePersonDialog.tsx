import type { IDBPDatabase } from 'idb';
import { useState, useTransition } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { createPerson } from '../../db/personMutations';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '../../designSystem';
import type { MyDB, StoredPerson } from '../../types/MyDB';
import styles from './QuickCreatePersonDialog.module.css';

interface QuickCreatePersonDialogProps {
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
 *
 * Parent mounts this conditionally so each open re-initializes `email` from `prefilledEmail`.
 */
export function QuickCreatePersonDialog({ prefilledEmail, db, ownerUserId, onCreated, onCancel }: QuickCreatePersonDialogProps) {
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
        });
    }

    return (
        <Dialog open onClose={onCancel} size="xs" fullWidth data-testid="quickCreatePersonDialog">
            <DialogTitle>Save as person</DialogTitle>
            <DialogContent>
                <div className={styles.fields}>
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
                </div>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel} disabled={isSaving}>
                    Cancel
                </Button>
                <Button onClick={onSave} variant="solid" disabled={!name.trim() || isSaving} data-testid="quickCreatePersonSave">
                    Save
                </Button>
            </DialogActions>
        </Dialog>
    );
}
