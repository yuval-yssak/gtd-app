import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useState } from 'react';
import { ClarifyDialog } from '../../components/ClarifyDialog';
import { EditItemDialog } from '../../components/EditItemDialog';
import { useAppData } from '../../contexts/AppDataContext';
import { clarifyToDone, clarifyToNextAction, clarifyToTrash, collectItem } from '../../db/itemMutations';
import type { StoredItem } from '../../types/MyDB';
import styles from './inbox.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_authenticated/inbox')({
    component: InboxPage,
});

function InboxPage() {
    const { db } = Route.useRouteContext();
    const { account, items, workContexts, people, refreshItems } = useAppData();
    const [draft, setDraft] = useState('');
    const [clarifyOpen, setClarifyOpen] = useState(false);
    const [editingItem, setEditingItem] = useState<StoredItem | null>(null);

    const inboxItems = items.filter((item) => item.status === 'inbox').sort((a, b) => b.createdTs.localeCompare(a.createdTs));

    async function onCapture() {
        const title = draft.trim();
        if (!title || !account) {
            return;
        }
        setDraft('');
        await collectItem(db, account.id, title);
        await refreshItems();
    }

    async function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Enter') await onCapture();
    }

    async function onQuickDone(item: StoredItem) {
        await clarifyToDone(db, item);
        await refreshItems();
    }

    async function onNextAction(item: StoredItem) {
        await clarifyToNextAction(db, item);
        await refreshItems();
    }

    async function onTrash(item: StoredItem) {
        await clarifyToTrash(db, item);
        await refreshItems();
    }

    return (
        <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
                <Typography variant="h5" fontWeight={600}>
                    Inbox
                    {inboxItems.length > 0 && <Chip label={inboxItems.length} size="small" color="primary" sx={{ ml: 1.5, verticalAlign: 'middle' }} />}
                </Typography>
                <Button variant="outlined" size="small" disabled={inboxItems.length === 0} onClick={() => setClarifyOpen(true)}>
                    Process Inbox ({inboxItems.length})
                </Button>
            </Box>

            <Paper variant="outlined" sx={{ mb: 3 }}>
                <TextField
                    fullWidth
                    placeholder="What's on your mind?"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    slotProps={{
                        input: {
                            endAdornment: (
                                <InputAdornment position="end">
                                    <IconButton onClick={onCapture} disabled={!draft.trim()} edge="end">
                                        <AddIcon />
                                    </IconButton>
                                </InputAdornment>
                            ),
                        },
                    }}
                    className={styles.captureField}
                />
            </Paper>

            {inboxItems.length === 0 ? (
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    Inbox zero — well done.
                </Typography>
            ) : (
                <List disablePadding className={styles.list}>
                    {inboxItems.map((item, idx) => (
                        <Box key={item._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => setEditingItem(item)}>
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Done (< 2 min)">
                                            <IconButton size="small" onClick={() => void onQuickDone(item)}>
                                                <PlaylistAddCheckIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Next Action">
                                            <Chip label="→ Next" size="small" onClick={() => void onNextAction(item)} sx={{ cursor: 'pointer' }} />
                                        </Tooltip>
                                        <Tooltip title="Trash">
                                            <IconButton size="small" color="error" onClick={() => void onTrash(item)}>
                                                <DeleteOutlineIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                {/* pr widened from 18→22 to make room for the extra edit button */}
                                <ListItemText primary={item.title} secondary={dayjs(item.createdTs).fromNow()} sx={{ pr: 22 }} />
                            </ListItem>
                            {idx < inboxItems.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
            {clarifyOpen && (
                <ClarifyDialog
                    items={inboxItems}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={() => setClarifyOpen(false)}
                    onItemProcessed={refreshItems}
                />
            )}
            {editingItem && <EditItemDialog item={editingItem} db={db} onClose={() => setEditingItem(null)} onSaved={refreshItems} />}
        </Box>
    );
}
