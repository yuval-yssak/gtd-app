import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { buildUsageIndex, EMPTY_USAGE_INDEX } from '../../lib/entityUsage';
import { DEFAULT_SEARCH_STATUSES } from '../../lib/itemSearch';
import { mergeFilterOptionsByName, resolveSelectedFilterOption } from '../../lib/mergedFilterOptions';
import { DEFAULT_URL_STATE } from '../../lib/searchUrlParams';
import { sampleNextActionItem, samplePeople, sampleWaitingForItem, sampleWorkContexts } from '../../test-utils/storybookMocks';
import { SearchFilters } from './SearchFilters';

const contextOptions = mergeFilterOptionsByName(sampleWorkContexts);
const personOptions = mergeFilterOptionsByName(samplePeople);

const meta = {
    title: 'Search/SearchFilters',
    component: SearchFilters,
    parameters: { layout: 'padded' },
    args: {
        urlState: DEFAULT_URL_STATE,
        queryInput: '',
        onQueryInputChange: fn(),
        onUrlStateChange: fn(),
        onReset: fn(),
        contextOptions,
        personOptions,
        selectedContext: undefined,
        selectedPerson: undefined,
        usage: buildUsageIndex([sampleNextActionItem, sampleWaitingForItem]),
        activeStatuses: DEFAULT_SEARCH_STATUSES,
    },
} satisfies Meta<typeof SearchFilters>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Defaults — the active statuses on, no person / context / date filter, no Reset chip. */
export const Default: Story = {};

/** A query, two statuses, a context, a person and a date range — chips lit, Clear search and Reset filters shown. */
export const FiltersActive: Story = {
    args: {
        urlState: {
            ...DEFAULT_URL_STATE,
            q: 'proposal',
            statuses: ['nextAction', 'waitingFor'],
            contextId: 'ctx-1',
            personId: 'person-2',
            dateFrom: '2026-10-01',
        },
        queryInput: 'proposal',
        activeStatuses: new Set(['nextAction', 'waitingFor']),
        selectedContext: resolveSelectedFilterOption('ctx-1', contextOptions, sampleWorkContexts),
        selectedPerson: resolveSelectedFilterOption('person-2', personOptions, samplePeople),
    },
};

/** Every status deselected — the deliberate "match nothing" state. */
export const NoStatuses: Story = {
    args: { urlState: { ...DEFAULT_URL_STATE, statuses: [] }, activeStatuses: new Set() },
};

/** No people or contexts defined yet — those chip rows are omitted. */
export const NoPeopleOrContexts: Story = {
    args: { contextOptions: [], personOptions: [], usage: EMPTY_USAGE_INDEX },
};
