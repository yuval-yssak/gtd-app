import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import type { IDBPDatabase } from 'idb';
import { useState, useTransition } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { createReviewInbox, removeReviewInbox, reorderReviewInboxes, updateReviewInbox } from '../../db/reviewInboxMutations';
import type { MyDB, StoredReviewInbox } from '../../types/MyDB';
import styles from './ManageInboxesDialog.module.css';

interface ManageInboxesDialogProps {
    db: IDBPDatabase<MyDB>;
    onClose: () => void;
}

/** Add / rename / remove / reorder the user-defined external inboxes used by the review checklist. */
export function ManageInboxesDialog({ db, onClose }: ManageInboxesDialogProps) {
    // allReviewInboxes (not the hidden-filtered set): when the active account is display-hidden,
    // its buckets must still be manageable here — the filtered list would render empty and rows
    // added would vanish immediately.
    const { account, allReviewInboxes, refreshReviewInboxes } = useAppData();
    const [newName, setNewName] = useState('');
    // Transition-gated mutations: onMove/onAdd compute positions from the rendered list, so a
    // second click before the first commit lands would work against stale indices (scrambled
    // order, duplicate `order` values). isMutating disables the controls for the in-flight window.
    const [isMutating, startMutation] = useTransition();

    const myInboxes = allReviewInboxes.filter((inbox) => inbox.userId === account?.id);

    function commit(mutation: () => Promise<unknown>) {
        startMutation(async () => {
            await mutation();
            await refreshReviewInboxes();
        });
    }

    function onAdd() {
        const name = newName.trim();
        if (!name || !account) {
            return;
        }
        setNewName('');
        commit(() => createReviewInbox(db, { userId: account.id, name, order: myInboxes.length }));
    }

    const onRename = (inbox: StoredReviewInbox, name: string) => commit(() => updateReviewInbox(db, { ...inbox, name }));
    const onRemove = (inbox: StoredReviewInbox) => commit(() => removeReviewInbox(db, inbox._id));

    function onMove(index: number, direction: -1 | 1) {
        const reordered = [...myInboxes];
        const [moved] = reordered.splice(index, 1);
        if (!moved) {
            return;
        }
        reordered.splice(index + direction, 0, moved);
        commit(() => reorderReviewInboxes(db, reordered));
    }

    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="xs" data-testid="manageInboxesDialog">
            <DialogTitle>Your inboxes</DialogTitle>
            <DialogContent>
                {myInboxes.map((inbox, index) => (
                    <Box key={inbox._id} className={styles.inboxRow} data-testid="manageInboxRow">
                        <RenameField name={inbox.name} onCommit={(name) => onRename(inbox, name)} />
                        <IconButton size="small" disabled={index === 0 || isMutating} onClick={() => onMove(index, -1)} aria-label="move up">
                            <ArrowUpwardIcon fontSize="inherit" />
                        </IconButton>
                        <IconButton
                            size="small"
                            disabled={index === myInboxes.length - 1 || isMutating}
                            onClick={() => onMove(index, 1)}
                            aria-label="move down"
                        >
                            <ArrowDownwardIcon fontSize="inherit" />
                        </IconButton>
                        <IconButton
                            size="small"
                            disabled={isMutating}
                            onClick={() => onRemove(inbox)}
                            aria-label="remove inbox"
                            data-testid="removeInboxButton"
                        >
                            <DeleteOutlineIcon fontSize="inherit" />
                        </IconButton>
                    </Box>
                ))}
                <Box className={styles.addRow}>
                    <TextField
                        size="small"
                        fullWidth
                        placeholder="Add an inbox (e.g. WhatsApp starred)"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') onAdd();
                        }}
                        slotProps={{ htmlInput: { 'data-testid': 'newInboxNameInput' } }}
                    />
                    <Button startIcon={<AddIcon />} disabled={!newName.trim() || isMutating} onClick={onAdd} data-testid="addInboxButton">
                        Add
                    </Button>
                </Box>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} data-testid="manageInboxesDone">
                    Done
                </Button>
            </DialogActions>
        </Dialog>
    );
}

/** Inline rename — commits on blur or Enter, only when the trimmed value actually changed. */
function RenameField({ name, onCommit }: { name: string; onCommit: (name: string) => void }) {
    const [value, setValue] = useState(name);

    function commitIfChanged() {
        const trimmed = value.trim();
        if (trimmed && trimmed !== name) {
            onCommit(trimmed);
        }
    }

    return (
        <TextField
            size="small"
            variant="standard"
            fullWidth
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commitIfChanged}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commitIfChanged();
            }}
        />
    );
}
