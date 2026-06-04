import BoltIcon from '@mui/icons-material/Bolt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlined';
import SellOutlinedIcon from '@mui/icons-material/SellOutlined';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { itemContextTags, itemPersonTags, type ResolvedTag } from '../../lib/itemSearch';
import type { EnergyLevel, StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './-next-actions.module.css';

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
    if (item.ignoreBefore && item.ignoreBefore > today) {
        return false;
    }
    if (filters.energy && item.energy !== filters.energy) {
        return false;
    }
    if (filters.maxMinutes && (item.time === undefined || item.time > filters.maxMinutes)) {
        return false;
    }
    if (filters.workContextId && !item.workContextIds?.includes(filters.workContextId)) {
        return false;
    }
    return true;
}

// Returns a toggle setter: clicking the same value again clears the filter.
function makeToggle<T>(setter: React.Dispatch<React.SetStateAction<T | null>>) {
    return (value: T) => setter((prev) => (prev === value ? null : value));
}

// "Show tags" preference persists across visits. Defaults ON; only an explicit 'false' hides them.
const SHOW_TAGS_KEY = 'nextActions.showTags';
export const readShowTags = () => localStorage.getItem(SHOW_TAGS_KEY) !== 'false';

interface RowTagsProps {
    contextTags: ResolvedTag[];
    personTags: ResolvedTag[];
    dueLabel: string | null;
}

// Second line of a next-action row: work-context chips (tag icon), people chips (person icon),
// then the optional "Due" text. Chips keyed by entity id — display names are not unique.
export function RowTags({ contextTags, personTags, dueLabel }: RowTagsProps) {
    if (contextTags.length === 0 && personTags.length === 0 && !dueLabel) {
        return null;
    }
    return (
        <Box component="span" className={styles.tagRow} data-testid="nextActionRowTags">
            {contextTags.map((tag) => (
                <Chip key={`ctx-${tag.id}`} icon={<SellOutlinedIcon />} label={tag.name} size="small" variant="outlined" />
            ))}
            {personTags.map((tag) => (
                <Chip key={`person-${tag.id}`} icon={<PersonOutlineIcon />} label={tag.name} size="small" color="info" variant="outlined" />
            ))}
            {dueLabel && (
                <Typography component="span" variant="caption" color="text.secondary" className={styles.dueText}>
                    {dueLabel}
                </Typography>
            )}
        </Box>
    );
}

interface RowSecondaryDeps {
    showTags: boolean;
    contextsById: Map<string, StoredWorkContext>;
    peopleById: Map<string, StoredPerson>;
}

// Builds a row's second line. Tags hidden → just the "Due" text (original behaviour, undefined when no date);
// tags shown → work-context + people chips precede it. Extracted so both branches are unit-testable.
export function buildRowSecondary(item: StoredItem, { showTags, contextsById, peopleById }: RowSecondaryDeps) {
    const dueLabel = item.expectedBy ? `Due ${dayjs(item.expectedBy).format('MMM D')}` : null;
    if (!showTags) {
        return dueLabel ?? undefined;
    }
    return <RowTags contextTags={itemContextTags(item, contextsById)} personTags={itemPersonTags(item, peopleById)} dueLabel={dueLabel} />;
}

function NextActionsPage() {
    const { db } = Route.useRouteContext();
    const { items, workContexts, people, routines, refreshItems, isInitialSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });
    const [energyFilter, setEnergyFilter] = useState<EnergyLevel | null>(null);
    const [timeFilter, setTimeFilter] = useState<TimeFilter>(null);
    const [contextFilter, setContextFilter] = useState<string | null>(null);
    const [showTags, setShowTags] = useState(readShowTags);

    const toggleEnergy = makeToggle(setEnergyFilter);
    const toggleTime = makeToggle(setTimeFilter);
    const toggleContext = makeToggle(setContextFilter);

    function onShowTagsToggled(next: boolean) {
        setShowTags(next);
        localStorage.setItem(SHOW_TAGS_KEY, String(next));
    }

    // Lookup maps for resolving an item's workContextIds / peopleIds to names without rescanning the arrays per row.
    const contextsById = useMemo(() => new Map(workContexts.map((c) => [c._id, c])), [workContexts]);
    const peopleById = useMemo(() => new Map(people.map((p) => [p._id, p])), [people]);

    const nextActions = items
        .filter((item) => item.status === 'nextAction')
        .filter((item) => matchesFilters(item, { energy: energyFilter, maxMinutes: timeFilter, workContextId: contextFilter }))
        .sort((a, b) => {
            // Four-tier sort: focused-with-date (expectedBy asc), focused-no-date, other-with-date
            // (expectedBy asc), other-no-date. Focus is the primary partition, presence of an
            // expectedBy is the secondary partition within each focus group.
            const af = a.focus === true;
            const bf = b.focus === true;
            if (af !== bf) {
                return af ? -1 : 1;
            }
            const aHas = Boolean(a.expectedBy);
            const bHas = Boolean(b.expectedBy);
            if (aHas !== bHas) {
                return aHas ? -1 : 1;
            }
            if (!aHas) {
                return 0;
            }
            return (a.expectedBy ?? '').localeCompare(b.expectedBy ?? '');
        });

    async function onDone(item: StoredItem) {
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
    }

    return (
        <Box>
            {/* mb on the wrapper (not the Typography) so the chip stays vertically centered with the title. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    Next Actions
                    {nextActions.length > 0 && <Chip label={nextActions.length} size="small" color="primary" className={styles.countChip} />}
                </Typography>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
            </Box>
            {/* Filter bar */}
            <Box
                sx={{
                    mb: 2,
                }}
            >
                {workContexts.length > 0 && (
                    <Stack
                        direction="row"
                        sx={{
                            flexWrap: 'wrap',
                            gap: 0.75,
                            mb: 1,
                        }}
                    >
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

                <Stack
                    direction="row"
                    sx={{
                        flexWrap: 'wrap',
                        gap: 0.75,
                    }}
                >
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
                <FormControlLabel
                    sx={{ mt: 0.5 }}
                    control={
                        <Switch size="small" checked={showTags} onChange={(e) => onShowTagsToggled(e.target.checked)} data-testid="nextActionsShowTagsToggle" />
                    }
                    label={<Typography variant="body2">Show tags</Typography>}
                />
            </Box>
            {nextActions.length === 0 ? (
                // isInitialSyncing is only true during first-launch bootstrap, when IDB is empty —
                // so an empty result then is "not loaded", not "filtered out". Show the skeleton.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Typography
                        sx={{
                            color: 'text.secondary',
                            textAlign: 'center',
                            mt: 6,
                        }}
                    >
                        No next actions match the current filters.
                    </Typography>
                )
            ) : (
                <List disablePadding className={styles.list}>
                    {nextActions.map((item, idx) => (
                        <Box key={item._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box className={styles.actionButtons}>
                                        <CopyIdButton id={item._id} testId="nextActionItemCopyIdButton" />
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => editor.openEditor({ item })} data-testid="nextActionItemEditButton">
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
                                <ListItemButton onClick={() => editor.openEditor({ item })} className={styles.rowButton} data-testid="nextActionItemRow">
                                    <ListItemText
                                        primary={
                                            <Box className={styles.titleRow}>
                                                {item.urgent && <BoltIcon fontSize="small" color="error" />}
                                                <span>{item.title}</span>
                                                {item.energy && <Chip label={energyLabels[item.energy]} size="small" color={energyColors[item.energy]} />}
                                                {item.time !== undefined && <Chip label={`${item.time} min`} size="small" variant="outlined" />}
                                                {item.routineId && (
                                                    <RoutineIndicator
                                                        routineId={item.routineId}
                                                        routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                                    />
                                                )}
                                                <AccountChip userId={item.userId} />
                                            </Box>
                                        }
                                        // secondary slot rendered as 'div' so chips (block content) can nest — the default <p> would be invalid DOM.
                                        slotProps={{ secondary: { component: 'div' } }}
                                        secondary={buildRowSecondary(item, { showTags, contextsById, peopleById })}
                                        className={styles.listItemText}
                                    />
                                </ListItemButton>
                            </ListItem>
                            {editor.renderExpandFor(item._id)}
                            {idx < nextActions.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
        </Box>
    );
}
