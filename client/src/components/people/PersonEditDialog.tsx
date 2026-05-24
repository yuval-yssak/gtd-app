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
import { updatePerson } from '../../db/personMutations';
import { reassignEntity } from '../../db/reassignMutations';
import type { MyDB, StoredPerson } from '../../types/MyDB';
import { AccountPicker } from '../AccountPicker';

interface PersonEditDialogProps {
    db: IDBPDatabase<MyDB>;
    person: StoredPerson;
    /**
     * When true and the device hosts >1 account, surfaces an account picker so the user can move
     * the person to another logged-in account. Defaults to false — only the `/people` route opts
     * in; MeetingDetails-launched edits stay focused on name/email/phone.
     */
    showAccountPicker?: boolean;
    onSaved: () => void;
    onCancel: () => void;
}

interface FormState {
    name: string;
    email: string;
    phone: string;
    ownerUserId: string;
}

/**
 * Reusable person-edit dialog shared between the `/people` route (full management) and the
 * MeetingDetails attendee chip (quick edit from a meeting). Mirrors the existing route form's
 * fields (name/email/phone) and optionally the account picker.
 *
 * Mount-on-open, like QuickCreatePersonDialog: callers conditionally render this component so the
 * `useState(person)` re-initializes on each open. Keeping it mounted with a toggled `open` would
 * freeze the form at the first person's values.
 *
 * Refresh policy: calls `useAppData().refreshPeople()` after writing so callers (MeetingDetails,
 * people route) don't have to remember to wire it up. The IDB write + sync queue happen inside
 * `updatePerson`; the refresh re-reads IDB into React state so chip labels / autocomplete update
 * without waiting for the next SSE pull.
 */
export function PersonEditDialog({ db, person, showAccountPicker = false, onSaved, onCancel }: PersonEditDialogProps) {
    const { loggedInAccounts, refreshPeople } = useAppData();
    const [form, setForm] = useState<FormState>({
        name: person.name,
        email: person.email ?? '',
        phone: person.phone ?? '',
        ownerUserId: person.userId,
    });
    const [isPending, startSave] = useTransition();

    function onSave() {
        const trimmedName = form.name.trim();
        if (!trimmedName) {
            return;
        }
        startSave(async () => {
            const next: StoredPerson = {
                ...person,
                name: trimmedName,
                ...(form.email.trim() ? { email: form.email.trim() } : {}),
                ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
            };
            await updatePerson(db, next);
            // Reassign happens after the local update so the owner-pivot operates on the freshly-saved row.
            if (showAccountPicker && form.ownerUserId !== person.userId) {
                await reassignEntity(db, { entityType: 'person', entityId: person._id, fromUserId: person.userId, toUserId: form.ownerUserId });
            }
            await refreshPeople();
            onSaved();
        });
    }

    const showPicker = showAccountPicker && loggedInAccounts.length > 1;

    return (
        <Dialog open onClose={onCancel} maxWidth="xs" fullWidth>
            <DialogTitle>Edit person</DialogTitle>
            <DialogContent>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                    <TextField
                        label="Name"
                        value={form.name}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                        fullWidth
                        autoFocus
                        required
                        data-testid="personEditName"
                    />
                    <TextField
                        label="Email"
                        value={form.email}
                        onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                        fullWidth
                        type="email"
                        data-testid="personEditEmail"
                    />
                    <TextField
                        label="Phone"
                        value={form.phone}
                        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                        fullWidth
                        data-testid="personEditPhone"
                    />
                    {showPicker && <AccountPicker value={form.ownerUserId} onChange={(v) => setForm((f) => ({ ...f, ownerUserId: v }))} />}
                </Box>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel} data-testid="personEditCancel">
                    Cancel
                </Button>
                <Button variant="contained" onClick={onSave} disabled={isPending || !form.name.trim()} data-testid="personEditSave">
                    Save
                </Button>
            </DialogActions>
        </Dialog>
    );
}
