import { Search, UserRound, X } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Chip, type ChipTone, IconButton, Select, Text, TextField } from '../../designSystem';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { type EntityUsage, rankMergedOptionsByUsage, type UsageIndex } from '../../lib/entityUsage';
import { ALL_STATUSES, STATUS_LABELS } from '../../lib/itemSearch';
import type { MergedFilterOption, SelectedFilterOption } from '../../lib/mergedFilterOptions';
import type { SearchUrlState } from '../../lib/searchUrlParams';
import { DEFAULT_URL_STATE, isDateField } from '../../lib/searchUrlParams';
import type { StoredItem } from '../../types/MyDB';
import { CollapsibleChipGroup } from '../pickers/CollapsibleChipGroup';
import { DateField } from '../pickers/DateField';
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
    activeTone: ChipTone;
    icon?: ReactElement | undefined;
    testId: string;
}

// Single-select chip row replacing the old Person / Work context dropdowns: the most-used options
// are visible at a glance (collapsed, usage-ranked); "+N more" expands to the full A→Z list.
// Same-named multi-account twins render as one chip (mirrors the next-actions filter rows).
function EntityFilterChipRow({ label, options, usageMap, selected, onSelect, activeTone, icon, testId }: EntityFilterChipRowProps) {
    const ranked = useMemo(() => rankMergedOptionsByUsage(options, usageMap), [options, usageMap]);
    const selectedIds = useMemo(() => new Set(selected?.option ? [selected.option.canonicalId] : []), [selected]);
    if (options.length === 0) {
        return null;
    }
    return (
        <div className={styles.row}>
            <Text as="span" variant="caption" tone="secondary" className={styles.rowLabel}>
                {label}
            </Text>
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
                            icon={icon}
                            label={option.name}
                            variant="outline"
                            tone={isActive ? activeTone : 'neutral'}
                            selected={isActive}
                            onClick={() => onSelect(isActive ? null : option.canonicalId)}
                            data-testid={testId}
                        />
                    );
                }}
            />
        </div>
    );
}

const DATE_FIELD_OPTIONS = [
    { value: 'updatedTs', label: 'Updated' },
    { value: 'createdTs', label: 'Created' },
];

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
        <div className={styles.filters}>
            <TextField
                fullWidth
                size="sm"
                placeholder="Search title and notes…"
                aria-label="Search title and notes"
                value={queryInput}
                onChange={(e) => onQueryInputChange(e.target.value)}
                inputRef={queryFieldRef}
                startAdornment={<Search size={20} aria-hidden="true" />}
                endAdornment={
                    queryInput ? (
                        <IconButton size="sm" onClick={() => onQueryInputChange('')} aria-label="Clear search">
                            <X />
                        </IconButton>
                    ) : undefined
                }
            />
            <div className={styles.row}>
                <Text as="span" variant="caption" tone="secondary" className={styles.rowLabel}>
                    Status
                </Text>
                <div className={styles.chips}>
                    {ALL_STATUSES.map((status) => {
                        const isOn = activeStatuses.has(status);
                        return <Chip key={status} label={STATUS_LABELS[status]} variant="outline" selected={isOn} onClick={() => toggleStatus(status)} />;
                    })}
                </div>
            </div>
            <EntityFilterChipRow
                label="Work context"
                options={contextOptions}
                usageMap={usage.contexts}
                selected={selectedContext}
                onSelect={(contextId) => onUrlStateChange({ contextId })}
                activeTone="accent"
                testId="searchContextFilterChip"
            />
            <EntityFilterChipRow
                label="Person"
                options={personOptions}
                usageMap={usage.people}
                selected={selectedPerson}
                onSelect={(personId) => onUrlStateChange({ personId })}
                activeTone="info"
                icon={<UserRound />}
                testId="searchPersonFilterChip"
            />
            <div className={styles.row}>
                <Select
                    size="sm"
                    label="Date field"
                    value={urlState.dateField}
                    onValueChange={(dateField) => isDateField(dateField) && onUrlStateChange({ dateField })}
                    options={DATE_FIELD_OPTIONS}
                    className={styles.dropdown}
                />
                <DateField
                    label="From"
                    value={urlState.dateFrom ?? ''}
                    onChange={(dateFrom) => onUrlStateChange({ dateFrom: dateFrom || null })}
                    className={styles.dateField}
                />
                <DateField
                    label="To"
                    value={urlState.dateTo ?? ''}
                    onChange={(dateTo) => onUrlStateChange({ dateTo: dateTo || null })}
                    className={styles.dateField}
                />
                {isFilterActive(urlState) && <Chip label="Reset filters" variant="outline" onClick={onReset} className={styles.resetChip} />}
            </div>
        </div>
    );
}
