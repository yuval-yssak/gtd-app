import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ALL_STATUSES, STATUS_LABELS } from '../../lib/itemSearch';
import type { SearchUrlState } from '../../lib/searchUrlParams';
import { DEFAULT_URL_STATE, isDateField } from '../../lib/searchUrlParams';
import type { StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './SearchFilters.module.css';

interface Props {
    urlState: SearchUrlState;
    queryInput: string;
    onQueryInputChange: (q: string) => void;
    onUrlStateChange: (next: Partial<SearchUrlState>) => void;
    onReset: () => void;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    activeStatuses: ReadonlySet<StoredItem['status']>;
}

const isFilterActive = (state: SearchUrlState) => {
    return (
        state.q !== DEFAULT_URL_STATE.q ||
        state.statuses !== null ||
        state.personId !== null ||
        state.contextId !== null ||
        state.dateFrom !== null ||
        state.dateTo !== null ||
        state.dateField !== DEFAULT_URL_STATE.dateField
    );
};

export function SearchFilters({ urlState, queryInput, onQueryInputChange, onUrlStateChange, onReset, people, workContexts, activeStatuses }: Props) {
    const toggleStatus = (status: StoredItem['status']) => {
        const next = new Set(activeStatuses);
        if (next.has(status)) {
            next.delete(status);
        } else {
            next.add(status);
        }
        // Empty set is a deliberate "match nothing" state from the user; preserve it
        // so they see a clear empty result rather than us silently re-adding defaults.
        onUrlStateChange({ statuses: [...next] });
    };

    return (
        <Box className={styles.filters}>
            <TextField
                fullWidth
                placeholder="Search title and notes…"
                value={queryInput}
                onChange={(e) => onQueryInputChange(e.target.value)}
                size="small"
                slotProps={{
                    input: {
                        startAdornment: (
                            <InputAdornment position="start">
                                <SearchIcon fontSize="small" />
                            </InputAdornment>
                        ),
                        endAdornment: queryInput ? (
                            <InputAdornment position="end">
                                <IconButton size="small" onClick={() => onQueryInputChange('')} aria-label="Clear search">
                                    <ClearIcon fontSize="small" />
                                </IconButton>
                            </InputAdornment>
                        ) : null,
                    },
                }}
            />
            <Box className={styles.row}>
                <Typography
                    variant="caption"
                    className={styles.rowLabel}
                    sx={{
                        color: 'text.secondary',
                    }}
                >
                    Status
                </Typography>
                <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{
                        flexWrap: 'wrap',
                    }}
                >
                    {ALL_STATUSES.map((status) => {
                        const isOn = activeStatuses.has(status);
                        return (
                            <Chip
                                key={status}
                                label={STATUS_LABELS[status]}
                                size="small"
                                color={isOn ? 'primary' : 'default'}
                                variant={isOn ? 'filled' : 'outlined'}
                                onClick={() => toggleStatus(status)}
                            />
                        );
                    })}
                </Stack>
            </Box>
            <Box className={styles.row}>
                <TextField
                    select
                    size="small"
                    label="Person"
                    value={urlState.personId ?? ''}
                    onChange={(e) => onUrlStateChange({ personId: e.target.value || null })}
                    className={styles.dropdown}
                >
                    <MenuItem value="">All people</MenuItem>
                    {people.map((p) => (
                        <MenuItem key={p._id} value={p._id}>
                            {p.name}
                        </MenuItem>
                    ))}
                </TextField>

                <TextField
                    select
                    size="small"
                    label="Work context"
                    value={urlState.contextId ?? ''}
                    onChange={(e) => onUrlStateChange({ contextId: e.target.value || null })}
                    className={styles.dropdown}
                >
                    <MenuItem value="">All contexts</MenuItem>
                    {workContexts.map((c) => (
                        <MenuItem key={c._id} value={c._id}>
                            {c.name}
                        </MenuItem>
                    ))}
                </TextField>
            </Box>
            <Box className={styles.row}>
                <TextField
                    select
                    size="small"
                    label="Date field"
                    value={urlState.dateField}
                    onChange={(e) => isDateField(e.target.value) && onUrlStateChange({ dateField: e.target.value })}
                    className={styles.dropdown}
                >
                    <MenuItem value="updatedTs">Updated</MenuItem>
                    <MenuItem value="createdTs">Created</MenuItem>
                </TextField>
                <TextField
                    type="date"
                    size="small"
                    label="From"
                    value={urlState.dateFrom ?? ''}
                    onChange={(e) => onUrlStateChange({ dateFrom: e.target.value || null })}
                    slotProps={{ inputLabel: { shrink: true } }}
                    className={styles.dateField}
                />
                <TextField
                    type="date"
                    size="small"
                    label="To"
                    value={urlState.dateTo ?? ''}
                    onChange={(e) => onUrlStateChange({ dateTo: e.target.value || null })}
                    slotProps={{ inputLabel: { shrink: true } }}
                    className={styles.dateField}
                />
                {isFilterActive(urlState) && <Chip label="Reset filters" size="small" variant="outlined" onClick={onReset} className={styles.resetChip} />}
            </Box>
        </Box>
    );
}
