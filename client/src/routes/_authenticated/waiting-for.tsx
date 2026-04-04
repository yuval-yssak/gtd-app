import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import EditIcon from '@mui/icons-material/Edit';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';
import { EditItemDialog } from '../../components/EditItemDialog';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { CLARIFY_MODE_KEY, parseClarifyMode } from '../../lib/clarifyMode';
import type { StoredItem } from '../../types/MyDB';
import styles from './-waiting-for.module.css';

export const Route = createFileRoute('/_authenticated/waiting-for')({
    component: WaitingForPage,
});

function WaitingForPage() {
    const { db } = Route.useRouteContext();
    const { items, people, routines, refreshItems } = useAppData();
    const navigate = useNavigate();
    const [editingItem, setEditingItem] = useState<StoredItem | null>(null);

    const waitingItems = items.filter((item) => item.status === 'waitingFor').sort((a, b) => (a.expectedBy ?? '').localeCompare(b.expectedBy ?? ''));

    const personMap = Object.fromEntries(people.map((p) => [p._id, p.name]));

    // Group by person (or "Unassigned")
    const groups = waitingItems.reduce<Record<string, StoredItem[]>>((acc, item) => {
        const key = item.waitingForPersonId ?? '__none__';
        acc[key] = [...(acc[key] ?? []), item];
        return acc;
    }, {});

    async function onReceived(item: StoredItem) {
        await clarifyToDone(db, item);
        await refreshItems();
    }

    const isOverdue = (item: StoredItem) => item.expectedBy !== undefined && item.expectedBy < dayjs().format('YYYY-MM-DD');

    if (waitingItems.length === 0) {
        return (
            <Box>
                <Typography variant="h5" fontWeight={600} mb={3}>
                    Waiting For
                </Typography>
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    Nothing pending.
                </Typography>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="h5" fontWeight={600} mb={3}>
                Waiting For
                <Chip label={waitingItems.length} size="small" color="primary" className={styles.countChip} />
            </Typography>
            {Object.entries(groups).map(([personId, groupItems]) => (
                <Box key={personId} mb={3}>
                    <Typography variant="subtitle2" color="text.secondary" fontWeight={600} mb={1}>
                        {personId === '__none__' ? 'Unassigned' : (personMap[personId] ?? 'Unknown')}
                    </Typography>
                    <List disablePadding className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <Box key={item._id}>
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    secondaryAction={
                                        <Box className={styles.actionButtons}>
                                            <Tooltip title="Edit">
                                                <IconButton
                                                    size="small"
                                                    onClick={() => {
                                                        // Read at click time — mode changes require a settings navigation
                                                        // which remounts this component, so no reactive state needed.
                                                        if (parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY)) === 'page') {
                                                            void navigate({ to: '/item/$itemId', params: { itemId: item._id }, search: { dest: null } });
                                                        } else {
                                                            setEditingItem(item);
                                                        }
                                                    }}
                                                >
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Received">
                                                <IconButton size="small" color="success" onClick={() => void onReceived(item)}>
                                                    <CheckCircleOutlineIcon />
                                                </IconButton>
                                            </Tooltip>
                                        </Box>
                                    }
                                >
                                    <ListItemText
                                        primary={
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                <span>{item.title}</span>
                                                {item.routineId && (
                                                    <RoutineIndicator
                                                        routineId={item.routineId}
                                                        routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                                    />
                                                )}
                                            </Box>
                                        }
                                        secondary={
                                            item.expectedBy ? (
                                                <Typography component="span" variant="caption" color={isOverdue(item) ? 'error' : 'text.secondary'}>
                                                    Expected by {dayjs(item.expectedBy).format('MMM D')}
                                                    {isOverdue(item) && ' — overdue'}
                                                </Typography>
                                            ) : undefined
                                        }
                                        className={styles.listItemText}
                                    />
                                </ListItem>
                                {idx < groupItems.length - 1 && <Divider />}
                            </Box>
                        ))}
                    </List>
                </Box>
            ))}
            {editingItem && <EditItemDialog item={editingItem} db={db} onClose={() => setEditingItem(null)} onSaved={refreshItems} />}
        </Box>
    );
}
