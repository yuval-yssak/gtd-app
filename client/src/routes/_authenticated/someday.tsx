import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd';
import EditIcon from '@mui/icons-material/Edit';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useState } from 'react';

dayjs.extend(relativeTime);

import { AccountChip } from '../../components/AccountChip';
import { EditItemDialog } from '../../components/EditItemDialog';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import type { StoredItem } from '../../types/MyDB';
import styles from './-someday.module.css';

export const Route = createFileRoute('/_authenticated/someday')({
    component: SomedayPage,
});

function SomedayPage() {
    const { db } = Route.useRouteContext();
    const { items, people, workContexts, routines, refreshItems } = useAppData();
    const [editingItem, setEditingItem] = useState<StoredItem | null>(null);

    const somedayItems = items.filter((item) => item.status === 'somedayMaybe').sort((a, b) => b.createdTs.localeCompare(a.createdTs));

    if (somedayItems.length === 0) {
        return (
            <Box>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                        mb: 3,
                    }}
                >
                    Someday / Maybe
                </Typography>
                <Paper variant="outlined" className={styles.emptyCard}>
                    <BookmarkAddIcon className={styles.icon} />
                    <Typography
                        variant="subtitle1"
                        sx={{
                            fontWeight: 600,
                            mb: 1,
                        }}
                    >
                        Nothing parked yet
                    </Typography>
                    <Typography
                        variant="body2"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Move items here from the edit dialog when you want to hold onto an idea without committing to it.
                    </Typography>
                </Paper>
            </Box>
        );
    }

    return (
        <Box>
            <Typography
                variant="h5"
                sx={{
                    fontWeight: 600,
                    mb: 3,
                }}
            >
                Someday / Maybe
                <Chip label={somedayItems.length} size="small" className={styles.countChip} />
            </Typography>
            <List disablePadding className={styles.list}>
                {somedayItems.map((item, idx) => (
                    <Box key={item._id}>
                        <ListItem
                            disablePadding
                            className={styles.item}
                            secondaryAction={
                                <Box className={styles.actionButtons}>
                                    <Tooltip title="Edit">
                                        <IconButton size="small" onClick={() => setEditingItem(item)} data-testid="somedayItemEditButton">
                                            <EditIcon fontSize="small" />
                                        </IconButton>
                                    </Tooltip>
                                </Box>
                            }
                        >
                            <ListItemButton onClick={() => setEditingItem(item)} className={styles.rowButton} data-testid="somedayItemRow">
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
                                            <AccountChip userId={item.userId} />
                                        </Box>
                                    }
                                    secondary={dayjs(item.createdTs).fromNow()}
                                />
                            </ListItemButton>
                        </ListItem>
                        {idx < somedayItems.length - 1 && <Divider />}
                    </Box>
                ))}
            </List>
            {editingItem && (
                <EditItemDialog
                    item={editingItem}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={() => setEditingItem(null)}
                    onSaved={refreshItems}
                />
            )}
        </Box>
    );
}
