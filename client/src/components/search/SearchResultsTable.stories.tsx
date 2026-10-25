import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { SEARCH_TABLE_COLUMNS, type SearchTableColumnId } from '../../lib/searchTableColumns';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import {
    sampleCalendarItem,
    sampleInboxItem,
    sampleNextActionItem,
    samplePeople,
    sampleWaitingForItem,
    sampleWorkContexts,
} from '../../test-utils/storybookMocks';
import { SearchResultsTable } from './SearchResultsTable';

const defaultColumns = new Set<SearchTableColumnId>(['title', 'status', 'updated', 'expectedBy']);
const allColumns = new Set(SEARCH_TABLE_COLUMNS.map((column) => column.id));

const meta = {
    title: 'Search/SearchResultsTable',
    component: SearchResultsTable,
    parameters: { layout: 'padded' },
    decorators: [editorProvidersDecorator(), RouterDecorator],
    args: {
        items: [sampleInboxItem, sampleNextActionItem, sampleCalendarItem, sampleWaitingForItem],
        visibleColumns: defaultColumns,
        onVisibleColumnsChange: fn(),
        people: samplePeople,
        workContexts: sampleWorkContexts,
    },
} satisfies Meta<typeof SearchResultsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default columns — title, status, updated, expected by. */
export const DefaultColumns: Story = {};

/** Every column on, including the resolved people and context names. */
export const AllColumns: Story = {
    args: { visibleColumns: allColumns },
};

/** The Columns menu open — Title is fixed (disabled), the rest toggle in place. */
export const ColumnPickerOpen: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await within(canvasElement).findByTestId('searchColumnsButton'));
        await within(document.body).findByRole('menu');
    },
};

/** Nothing matched — the header row only. */
export const NoResults: Story = {
    args: { items: [] },
};
