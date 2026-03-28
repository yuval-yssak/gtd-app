import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
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
import { getItemsByUser } from '../../db/itemHelpers';
import { clarifyToDone, clarifyToNextAction, clarifyToTrash, collectItem } from '../../db/itemMutations';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { usePeople } from '../../hooks/usePeople';
import { useWorkContexts } from '../../hooks/useWorkContexts';
import type { StoredItem } from '../../types/MyDB';
import styles from './inbox.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_authenticated/inbox')({
    component: InboxPage,
});

function InboxPage() {
    const { db, items, setItems } = Route.useRouteContext();
    const account = useActiveAccount(db);
    const [draft, setDraft] = useState('');
    const [clarifyOpen, setClarifyOpen] = useState(false);
    const people = usePeople(db, account?.id ?? null);
    const workContexts = useWorkContexts(db, account?.id ?? null);

    console.log({ db, items, setItems, account, draft, clarifyOpen, people, workContexts });
    const inboxItems = items.filter((item) => item.status === 'inbox').sort((a, b) => b.createdTs.localeCompare(a.createdTs));

    async function refreshItems() {
        if (!account) return;
        const refreshed = await getItemsByUser(db, account.id);
        setItems(refreshed);
    }

    async function onCapture() {
        const title = draft.trim();
        if (!title || !account) return;
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
                    sx={{ '& .MuiOutlinedInput-notchedOutline': { border: 'none' } }}
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
                                <ListItemText primary={item.title} secondary={dayjs(item.createdTs).fromNow()} sx={{ pr: 18 }} />
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
        </Box>
    );
}
