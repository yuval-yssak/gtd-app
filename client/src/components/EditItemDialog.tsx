import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { updateItem } from '../db/itemMutations';
import type { MyDB, StoredItem } from '../types/MyDB';
import styles from './EditItemDialog.module.css';

interface Props {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    onClose: () => void;
    onSaved: () => Promise<void>;
}

export function EditItemDialog({ item, db, onClose, onSaved }: Props) {
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    // 0 = edit tab, 1 = preview tab
    const [notesTab, setNotesTab] = useState<0 | 1>(0);

    async function onSave() {
        const trimmedTitle = title.trim();
        const trimmedNotes = notes.trim();
        // exactOptionalPropertyTypes requires omitting the key rather than assigning undefined
        const { notes: _n, ...rest } = item;
        const updated: StoredItem = trimmedNotes ? { ...rest, title: trimmedTitle, notes: trimmedNotes } : { ...rest, title: trimmedTitle };
        await updateItem(db, updated);
        await onSaved();
        onClose();
    }

    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>Edit item</DialogTitle>
            <DialogContent className={styles.dialogContent}>
                <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth required autoFocus />
                <div>
                    <Tabs value={notesTab} onChange={(_, v) => setNotesTab(v as 0 | 1)} className={styles.tabs}>
                        <Tab label="Edit" value={0} />
                        <Tab label="Preview" value={1} />
                    </Tabs>
                    {notesTab === 0 ? (
                        <TextField
                            label="Notes (Markdown)"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            fullWidth
                            multiline
                            rows={6}
                            placeholder="Supports **bold**, _italic_, `code`, lists, etc."
                        />
                    ) : (
                        // bracket notation required: CSS module type is an index signature, dot-access disallowed by TS strict config
                        <div className={styles.preview}>
                            {notes.trim() ? <ReactMarkdown>{notes}</ReactMarkdown> : <span className={styles.empty}>Nothing to preview.</span>}
                        </div>
                    )}
                </div>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" onClick={() => void onSave()} disabled={!title.trim()}>
                    Save
                </Button>
            </DialogActions>
        </Dialog>
    );
}
