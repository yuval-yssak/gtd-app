import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import type { IDBPDatabase } from 'idb';
import { useEffect, useRef, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { reassignEntity } from '../../db/reassignMutations';
import { updateWorkContext } from '../../db/workContextMutations';
import { useAutosave } from '../../hooks/useAutosave';
import { offerUndo } from '../../lib/undoStore';
import type { MyDB, StoredWorkContext } from '../../types/MyDB';
import { AccountPicker } from '../AccountPicker';

interface WorkContextEditDialogProps {
    db: IDBPDatabase<MyDB>;
    workContext: StoredWorkContext;
    onClose: () => void;
}

/**
 * Rename dialog for an existing work context — fully autosaving (no Save button; Close only).
 * Typing debounces into `updateWorkContext` with a "Saved — UNDO" snackbar. Remote renames
 * live-merge in while the field is untouched; a mid-edit remote rename keeps the local text
 * (it re-commits within a debounce tick). Owner reassignment applies immediately on selection.
 *
 * Mount-on-open: the caller conditionally renders this so state re-seeds per context.
 */
export function WorkContextEditDialog({ db, workContext, onClose }: WorkContextEditDialogProps) {
    const { loggedInAccounts, refreshWorkContexts, workContexts } = useAppData();
    const liveContext = workContexts.find((c) => c._id === workContext._id) ?? workContext;
    const liveContextRef = useRef(liveContext);
    liveContextRef.current = liveContext;

    const [name, setName] = useState(workContext.name);
    const nameRef = useRef(name);
    nameRef.current = name;
    // Live name the field was last seeded/merged from — differing means the user is mid-edit.
    const seedNameRef = useRef(workContext.name);

    const autosave = useAutosave<string>({
        initial: workContext.name,
        commit: async (value, baseline) => {
            if (!value.trim()) {
                return; // never persist a blank name; the field shows the error state
            }
            await updateWorkContext(db, { ...liveContextRef.current, name: value.trim() });
            offerUndo({
                key: `workContext:${workContext._id}`,
                message: 'Context saved',
                undo: async () => {
                    await updateWorkContext(db, { ...liveContextRef.current, name: baseline.trim() });
                    setName(baseline);
                    autosave.reset(baseline);
                    await refreshWorkContexts();
                },
                onExpire: () => autosave.endBurst(),
            });
            await refreshWorkContexts();
        },
    });

    // Live merge (single field): adopt a remote rename only while the input is untouched.
    useEffect(() => {
        if (liveContext.name === seedNameRef.current) {
            return;
        }
        const isClean = nameRef.current === seedNameRef.current;
        seedNameRef.current = liveContext.name;
        if (isClean) {
            setName(liveContext.name);
            autosave.reset(liveContext.name);
        }
    }, [liveContext.name, autosave]);

    async function onOwnerPicked(nextOwnerUserId: string) {
        if (nextOwnerUserId === liveContextRef.current.userId) {
            return;
        }
        await autosave.flush(); // the move must carry any rename still in the debounce window
        const fromUserId = liveContextRef.current.userId;
        await reassignEntity(db, { entityType: 'workContext', entityId: workContext._id, fromUserId, toUserId: nextOwnerUserId });
        offerUndo({
            key: `workContext:${workContext._id}:owner`,
            message: `Moved to ${loggedInAccounts.find((a) => a.id === nextOwnerUserId)?.email ?? 'the other account'}`,
            undo: async () => {
                await reassignEntity(db, { entityType: 'workContext', entityId: workContext._id, fromUserId: nextOwnerUserId, toUserId: fromUserId });
                await refreshWorkContexts();
            },
        });
        await refreshWorkContexts();
        onClose();
    }

    return (
        <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle>Rename context</DialogTitle>
            <DialogContent>
                <TextField
                    label="Name"
                    placeholder="e.g. @office, @phone"
                    value={name}
                    onChange={(e) => {
                        setName(e.target.value);
                        autosave.onChange(e.target.value);
                    }}
                    onBlur={() => void autosave.flush()}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            void autosave.flush().then(onClose);
                        }
                    }}
                    fullWidth
                    autoFocus
                    error={!name.trim()}
                    helperText={name.trim() ? undefined : 'Name is required — changes are not saved while empty.'}
                    sx={{ mt: 1 }}
                    data-testid="workContextEditName"
                />
                {loggedInAccounts.length > 1 && <AccountPicker value={liveContext.userId} onChange={(v) => void onOwnerPicked(v)} />}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} data-testid="workContextEditClose">
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    );
}
