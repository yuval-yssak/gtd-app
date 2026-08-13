import ClearIcon from '@mui/icons-material/Clear';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlined';
import SearchIcon from '@mui/icons-material/Search';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { type EntityUsage, rankMergedOptionsByUsage, type UsageIndex } from '../../lib/entityUsage';
import { ALL_STATUSES, STATUS_LABELS } from '../../lib/itemSearch';
import type { MergedFilterOption, SelectedFilterOption } from '../../lib/mergedFilterOptions';
import type { SearchUrlState } from '../../lib/searchUrlParams';
import { DEFAULT_URL_STATE, isDateField } from '../../lib/searchUrlParams';
import type { StoredItem } from '../../types/MyDB';
import { CollapsibleChipGroup } from '../pickers/CollapsibleChipGroup';
import styles from './SearchFilters.module.css';

interface Props {
    urlState: SearchUrlState;
    queryInput: string;
    onQueryInputChange: (q: string) => void;
    onUrlStateChange: (next: Partial<SearchUrlState>) => void;
    onReset: () => void;
    /** Merged (same-name multi-account) chip options and the resolved active selection per row —
     *  computed by the page so the filtering pipeline shares the exact same objects. */
    contextOptions: MergedFilterOption[];
    personOptions: MergedFilterOption[];
    selectedContext: SelectedFilterOption | undefined;
    selectedPerson: SelectedFilterOption | undefined;
    /** Ranks the person/context chip rows most-used-first and drives their collapse. */
    usage: UsageIndex;
    activeStatuses: ReadonlySet<StoredItem['status']>;
}

interface EntityFilterChipRowProps {
    label: string;
    /** Merged options, A→Z (mergeFilterOptionsByName's order) — the expanded view. */
    options: MergedFilterOption[];
    usageMap: ReadonlyMap<string, EntityUsage>;
    /** Resolved active selection — undefined when the row's filter is unset. */
    selected: SelectedFilterOption | undefined;
    /** Receives the clicked option's canonicalId, or null when the active chip is clicked again. */
    onSelect: (id: string | null) => void;
    activeColor: 'primary' | 'info';
    icon?: React.ReactElement;
    testId: string;
}

// Single-select chip row replacing the old Person / Work context dropdowns: the most-used options
// are visible at a glance (collapsed, usage-ranked); "+N more" expands to the full A→Z list.
// Same-named multi-account twins render as one chip (mirrors the next-actions filter rows).
function EntityFilterChipRow({ label, options, usageMap, selected, onSelect, activeColor, icon, testId }: EntityFilterChipRowProps) {
    const ranked = useMemo(() => rankMergedOptionsByUsage(options, usageMap), [options, usageMap]);
    const selectedIds = useMemo(() => new Set(selected?.option ? [selected.option.canonicalId] : []), [selected]);
    if (options.length === 0) {
        return null;
    }
    return (
        <Box className={styles.row}>
            <Typography
                variant="caption"
                className={styles.rowLabel}
                sx={{
                    color: 'text.secondary',
                }}
            >
                {label}
            </Typography>
            <CollapsibleChipGroup
                ranked={ranked}
                alphabetical={options}
                selectedIds={selectedIds}
                keyOf={(option) => option.canonicalId}
                testId={testId}
                renderChip={(option) => {
                    const isActive = option.canonicalId === selected?.option?.canonicalId;
                    return (
                        <Chip
                            {...(icon ? { icon } : {})}
                            label={option.name}
                            size="small"
                            variant={isActive ? 'filled' : 'outlined'}
                            color={isActive ? activeColor : 'default'}
                            onClick={() => onSelect(isActive ? null : option.canonicalId)}
                            data-testid={testId}
                        />
                    );
                }}
            />
        </Box>
    );
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

export function SearchFilters({
    urlState,
    queryInput,
    onQueryInputChange,
    onUrlStateChange,
    onReset,
    contextOptions,
    personOptions,
    selectedContext,
    selectedPerson,
    usage,
    activeStatuses,
}: Props) {
    const queryFieldRef = useAutoFocus();

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
                    htmlInput: { ref: queryFieldRef },
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
            <EntityFilterChipRow
                label="Work context"
                options={contextOptions}
                usageMap={usage.contexts}
                selected={selectedContext}
                onSelect={(contextId) => onUrlStateChange({ contextId })}
                activeColor="primary"
                testId="searchContextFilterChip"
            />
            <EntityFilterChipRow
                label="Person"
                options={personOptions}
                usageMap={usage.people}
                selected={selectedPerson}
                onSelect={(personId) => onUrlStateChange({ personId })}
                activeColor="info"
                icon={<PersonOutlineIcon />}
                testId="searchPersonFilterChip"
            />
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
