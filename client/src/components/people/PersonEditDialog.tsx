import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import type { IDBPDatabase } from 'idb';
import { useEffect, useRef, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { updatePerson } from '../../db/personMutations';
import { attemptReassign, reassignEntity } from '../../db/reassignMutations';
import { useAutosave } from '../../hooks/useAutosave';
import { mergeCleanStringFields, stringFieldsEqual } from '../../lib/liveMerge';
import { offerUndo } from '../../lib/undoStore';
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
    onClose: () => void;
}

// Type alias (not interface) so it satisfies the Record<string, string> constraint in lib/liveMerge.
type PersonTextFields = {
    name: string;
    email: string;
    phone: string;
    notes: string;
};

function textFieldsOf(person: StoredPerson): PersonTextFields {
    return { name: person.name, email: person.email ?? '', phone: person.phone ?? '', notes: person.notes ?? '' };
}

/** Overlays the edited text fields on the live person row. Blank email/phone/notes omit the key —
 *  exactOptionalPropertyTypes + the op validator's NonEmptyString rule both forbid ''. */
function applyTextFields(base: StoredPerson, fields: PersonTextFields): StoredPerson {
    const { email: _e, phone: _p, notes: _n, ...rest } = base;
    return {
        ...rest,
        name: fields.name.trim(),
        ...(fields.email.trim() ? { email: fields.email.trim() } : {}),
        ...(fields.phone.trim() ? { phone: fields.phone.trim() } : {}),
        ...(fields.notes.trim() ? { notes: fields.notes.trim() } : {}),
    };
}

/**
 * Person editor — fully autosaving (no Save button). Text edits debounce into `updatePerson`
 * writes with a "Saved — UNDO" snackbar; the dialog only offers Close. Remote changes from other
 * devices live-merge into fields the user hasn't touched (see lib/liveMerge for the policy).
 *
 * Mount-on-open, like before: callers conditionally render this component so state re-seeds per
 * person. Owner reassignment (account picker) is a deliberate discrete action — it applies
 * immediately on selection, then closes the dialog (the person now renders under another account).
 */
export function PersonEditDialog({ db, person, showAccountPicker = false, onClose }: PersonEditDialogProps) {
    const { loggedInAccounts, refreshPeople, people } = useAppData();
    // Live row — reflects both remote sync merges and our own committed autosaves.
    const livePerson = people.find((p) => p._id === person._id) ?? person;
    const livePersonRef = useRef(livePerson);
    livePersonRef.current = livePerson;

    const [ownerError, setOwnerError] = useState<string | null>(null);
    const [isOwnerMoveInFlight, setIsOwnerMoveInFlight] = useState(false);
    // Skip setState after unmount — the reassign await can outlive the dialog if the user closes
    // it mid-flight (same guard PendingReassignProvider uses for its revert snackbar).
    const unmountedRef = useRef(false);
    useEffect(() => {
        return () => {
            unmountedRef.current = true;
        };
    }, []);
    const [form, setForm] = useState<PersonTextFields>(textFieldsOf(person));
    const formRef = useRef(form);
    formRef.current = form;
    // The live values the form was last seeded/merged from — a field is "dirty" iff it differs.
    const seedRef = useRef<PersonTextFields>(textFieldsOf(person));

    const autosave = useAutosave<PersonTextFields>({
        initial: textFieldsOf(person),
        commit: async (value, baseline) => {
            if (!value.name.trim()) {
                return; // name is required — never persist a blank; the field shows the error state
            }
            await updatePerson(db, applyTextFields(livePersonRef.current, value));
            offerUndo({
                key: `person:${person._id}`,
                message: 'Person saved',
                undo: async () => {
                    await updatePerson(db, applyTextFields(livePersonRef.current, baseline));
                    setForm(baseline);
                    autosave.reset(baseline);
                    await refreshPeople();
                },
                onExpire: () => autosave.endBurst(),
            });
            await refreshPeople();
        },
    });

    // Live merge: when the row changes underneath the open dialog (another device, or our own
    // committed autosave echoing back), adopt new values into clean fields; dirty fields keep the
    // local text (it re-commits within one debounce tick, so the conflict window is sub-second).
    useEffect(() => {
        const liveFields = textFieldsOf(livePerson);
        if (stringFieldsEqual(liveFields, seedRef.current)) {
            return;
        }
        const merged = mergeCleanStringFields(formRef.current, seedRef.current, liveFields);
        seedRef.current = liveFields;
        setForm(merged);
        if (stringFieldsEqual(merged, liveFields)) {
            // Fully clean/adopted — tighten the controller baseline to the live values.
            autosave.reset(liveFields);
        } else {
            // A burst is in flight: no reset (it would drop the undo baseline). onChange updates
            // the controller's latest value so the pending commit carries the merged clean fields
            // instead of re-asserting their pre-merge values.
            autosave.onChange(merged);
        }
    }, [livePerson, autosave]);

    function onFieldChange(key: keyof PersonTextFields, value: string) {
        const next = { ...formRef.current, [key]: value };
        setForm(next);
        autosave.onChange(next);
    }

    async function onOwnerPicked(nextOwnerUserId: string) {
        if (nextOwnerUserId === livePersonRef.current.userId) {
            return;
        }
        setOwnerError(null);
        setIsOwnerMoveInFlight(true);
        await autosave.flush(); // the move must carry any text still in the debounce window
        const fromUserId = livePersonRef.current.userId;
        const label = livePersonRef.current.name;
        const outcome = await attemptReassign(db, { entityType: 'person', entityId: person._id, fromUserId, toUserId: nextOwnerUserId }, label);
        if (unmountedRef.current) {
            return;
        }
        setIsOwnerMoveInFlight(false);
        if (!outcome.ok) {
            // Keep the dialog open with the failure inline — closing with a false "Moved to …"
            // snackbar would tell the user the move happened when it didn't.
            setOwnerError(outcome.message);
            return;
        }
        offerUndo({
            key: `person:${person._id}:owner`,
            message: `Moved to ${loggedInAccounts.find((a) => a.id === nextOwnerUserId)?.email ?? 'the other account'}`,
            undo: async () => {
                await reassignEntity(db, { entityType: 'person', entityId: person._id, fromUserId: nextOwnerUserId, toUserId: fromUserId });
                await refreshPeople();
            },
        });
        await refreshPeople();
        onClose();
    }

    const showPicker = showAccountPicker && loggedInAccounts.length > 1;

    return (
        <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle>Edit person</DialogTitle>
            <DialogContent>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                    <TextField
                        label="Name"
                        value={form.name}
                        onChange={(e) => onFieldChange('name', e.target.value)}
                        onBlur={() => void autosave.flush()}
                        fullWidth
                        autoFocus
                        required
                        error={!form.name.trim()}
                        helperText={form.name.trim() ? undefined : 'Name is required — changes are not saved while empty.'}
                        data-testid="personEditName"
                    />
                    <TextField
                        label="Email"
                        value={form.email}
                        onChange={(e) => onFieldChange('email', e.target.value)}
                        onBlur={() => void autosave.flush()}
                        fullWidth
                        type="email"
                        data-testid="personEditEmail"
                    />
                    <TextField
                        label="Phone"
                        value={form.phone}
                        onChange={(e) => onFieldChange('phone', e.target.value)}
                        onBlur={() => void autosave.flush()}
                        fullWidth
                        data-testid="personEditPhone"
                    />
                    <TextField
                        label="Notes"
                        value={form.notes}
                        onChange={(e) => onFieldChange('notes', e.target.value)}
                        onBlur={() => void autosave.flush()}
                        fullWidth
                        multiline
                        minRows={3}
                        helperText="Markdown supported"
                        data-testid="personEditNotes"
                    />
                    {showPicker && (
                        <AccountPicker
                            value={livePerson.userId}
                            onChange={(v) => void onOwnerPicked(v)}
                            disabled={isOwnerMoveInFlight}
                            {...(ownerError ? { error: ownerError } : {})}
                        />
                    )}
                </Box>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} data-testid="personEditClose">
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    );
}
