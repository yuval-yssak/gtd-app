import Box from '@mui/material/Box';
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
import { type ItemEditorChrome, shouldAutoFocusTitle } from '../editItemDialogLogic';

/** Person editor supports only dialog + page today; typed off the shared union so a future
 *  chrome rollout extends one type instead of hunting for a second declaration here. */
export type PersonEditorChrome = Extract<ItemEditorChrome, 'dialog' | 'page'>;

interface PersonEditorBodyProps {
    db: IDBPDatabase<MyDB>;
    person: StoredPerson;
    /**
     * When true and the device hosts >1 account, surfaces an account picker so the user can move
     * the person to another logged-in account. Defaults to false — only the `/people` route and
     * the person page opt in; MeetingDetails-launched edits stay focused on name/email/phone.
     */
    showAccountPicker?: boolean;
    /** 'page' skips the name auto-focus — the full-page route is read-mostly, like the item page. */
    chrome?: PersonEditorChrome;
    /** Called after a completed owner move — the person now renders under another account. */
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
 * Person editor fields — fully autosaving (no Save button). Text edits debounce into
 * `updatePerson` writes with a "Saved — UNDO" snackbar. Remote changes from other devices
 * live-merge into fields the user hasn't touched (see lib/liveMerge for the policy).
 *
 * Chrome-less: PersonEditDialog wraps it in a Dialog, the /person/$personId route in a page card.
 * Mount-per-person, like before: callers key or conditionally render this component so state
 * re-seeds per person. Owner reassignment (account picker) is a deliberate discrete action — it
 * applies immediately on selection, then calls `onClose` (the person now renders under another
 * account).
 */
export function PersonEditorBody({ db, person, showAccountPicker = false, chrome = 'dialog', onClose }: PersonEditorBodyProps) {
    const { loggedInAccounts, refreshPeople, allPeople } = useAppData();
    // Live row — reflects both remote sync merges and our own committed autosaves. Deliberately
    // the unfiltered allPeople (not the account-visibility-filtered `people` the /people list
    // renders from): the deep-linked page must keep merging when the owner account is toggled
    // out of view, and it's benign for the dialog, which can only open from a visible row.
    const livePerson = allPeople.find((p) => p._id === person._id) ?? person;
    const livePersonRef = useRef(livePerson);
    livePersonRef.current = livePerson;
    // The row can disappear underneath the editor (a sync pull applies a remote delete) — the
    // flush-on-unmount autosave would then resurrect it from the stale livePersonRef, queueing
    // an update op for an entity the server just deleted. Commit bails when the row is gone.
    const isPersonLiveRef = useRef(true);
    isPersonLiveRef.current = allPeople.some((p) => p._id === person._id);

    const [ownerError, setOwnerError] = useState<string | null>(null);
    const [isOwnerMoveInFlight, setIsOwnerMoveInFlight] = useState(false);
    // Skip setState after unmount — the reassign await can outlive the editor if the user closes
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
            if (!isPersonLiveRef.current) {
                return; // remotely deleted mid-edit — see the ref's comment; saving would resurrect
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

    // Live merge: when the row changes underneath the open editor (another device, or our own
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
            // Keep the editor open with the failure inline — closing with a false "Moved to …"
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
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField
                label="Name"
                value={form.name}
                onChange={(e) => onFieldChange('name', e.target.value)}
                onBlur={() => void autosave.flush()}
                fullWidth
                autoFocus={shouldAutoFocusTitle(chrome, undefined)}
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
    );
}
