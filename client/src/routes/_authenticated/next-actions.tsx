import BoltIcon from '@mui/icons-material/Bolt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import EditIcon from '@mui/icons-material/Edit';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';
import { EditNextActionDialog } from '../../components/EditNextActionDialog';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import type { EnergyLevel, StoredItem } from '../../types/MyDB';
import styles from './next-actions.module.css';

export const Route = createFileRoute('/_authenticated/next-actions')({
    component: NextActionsPage,
});

type TimeFilter = 5 | 30 | 60 | null;

interface ActiveFilters {
    energy: EnergyLevel | null;
    maxMinutes: TimeFilter;
    workContextId: string | null;
}

const energyLabels: Record<EnergyLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const energyColors: Record<EnergyLevel, 'default' | 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
};

function matchesFilters(item: StoredItem, filters: ActiveFilters): boolean {
    const today = dayjs().format('YYYY-MM-DD');
    if (item.ignoreBefore && item.ignoreBefore > today) return false;
    if (filters.energy && item.energy !== filters.energy) return false;
    if (filters.maxMinutes && (item.time === undefined || item.time > filters.maxMinutes)) return false;
    if (filters.workContextId && !item.workContextIds?.includes(filters.workContextId)) return false;
    return true;
}

// Returns a toggle setter: clicking the same value again clears the filter.
function makeToggle<T>(setter: React.Dispatch<React.SetStateAction<T | null>>) {
    return (value: T) => setter((prev) => (prev === value ? null : value));
}

function NextActionsPage() {
    const { db } = Route.useRouteContext();
    const { items, workContexts, people, refreshItems } = useAppData();
    const [energyFilter, setEnergyFilter] = useState<EnergyLevel | null>(null);
    const [timeFilter, setTimeFilter] = useState<TimeFilter>(null);
    const [contextFilter, setContextFilter] = useState<string | null>(null);
    const [editingItem, setEditingItem] = useState<StoredItem | null>(null);

    const toggleEnergy = makeToggle(setEnergyFilter);
    const toggleTime = makeToggle(setTimeFilter);
    const toggleContext = makeToggle(setContextFilter);

    const nextActions = items
        .filter((item) => item.status === 'nextAction')
        .filter((item) => matchesFilters(item, { energy: energyFilter, maxMinutes: timeFilter, workContextId: contextFilter }))
        .sort((a, b) => {
            // Urgent items first, then by expectedBy ascending (empty strings sort last)
            if (a.urgent && !b.urgent) return -1;
            if (!a.urgent && b.urgent) return 1;
            return (a.expectedBy ?? '').localeCompare(b.expectedBy ?? '');
        });

    async function onDone(item: StoredItem) {
        await clarifyToDone(db, item);
        await refreshItems();
    }

    return (
        <Box>
            <Typography variant="h5" fontWeight={600} mb={2}>
                Next Actions
                {nextActions.length > 0 && <Chip label={nextActions.length} size="small" color="primary" className={styles.countChip} />}
            </Typography>

            {/* Filter bar */}
            <Box mb={2}>
                {workContexts.length > 0 && (
                    <Stack direction="row" flexWrap="wrap" gap={0.75} mb={1}>
                        {workContexts.map((ctx) => (
                            <Chip
                                key={ctx._id}
                                label={ctx.name}
                                size="small"
                                variant={contextFilter === ctx._id ? 'filled' : 'outlined'}
                                color={contextFilter === ctx._id ? 'primary' : 'default'}
                                onClick={() => toggleContext(ctx._id)}
                            />
                        ))}
                    </Stack>
                )}

                <Stack direction="row" flexWrap="wrap" gap={0.75}>
                    {(['low', 'medium', 'high'] as EnergyLevel[]).map((e) => (
                        <Chip
                            key={e}
                            label={`${energyLabels[e]} energy`}
                            size="small"
                            variant={energyFilter === e ? 'filled' : 'outlined'}
                            color={energyFilter === e ? energyColors[e] : 'default'}
                            onClick={() => toggleEnergy(e)}
                        />
                    ))}
                    {([5, 30, 60] as const).map((t) => (
                        <Chip
                            key={t}
                            label={`≤ ${t} min`}
                            size="small"
                            variant={timeFilter === t ? 'filled' : 'outlined'}
                            color={timeFilter === t ? 'primary' : 'default'}
                            onClick={() => toggleTime(t)}
                        />
                    ))}
                </Stack>
            </Box>

            {nextActions.length === 0 ? (
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    No next actions match the current filters.
                </Typography>
            ) : (
                <List disablePadding className={styles.list}>
                    {nextActions.map((item, idx) => (
                        <Box key={item._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box className={styles.actionButtons}>
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => setEditingItem(item)}>
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Mark done">
                                            <IconButton size="small" color="success" onClick={() => void onDone(item)}>
                                                <CheckCircleOutlineIcon />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                <ListItemText
                                    primary={
                                        <Box className={styles.titleRow}>
                                            {item.urgent && <BoltIcon fontSize="small" color="error" />}
                                            <span>{item.title}</span>
                                            {item.energy && <Chip label={energyLabels[item.energy]} size="small" color={energyColors[item.energy]} />}
                                            {item.time !== undefined && <Chip label={`${item.time} min`} size="small" variant="outlined" />}
                                        </Box>
                                    }
                                    secondary={item.expectedBy ? `Due ${dayjs(item.expectedBy).format('MMM D')}` : undefined}
                                    className={styles.listItemText}
                                />
                            </ListItem>
                            {idx < nextActions.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
            {editingItem && (
                <EditNextActionDialog
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
