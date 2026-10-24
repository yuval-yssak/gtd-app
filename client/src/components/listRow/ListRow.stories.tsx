import type { Meta, StoryObj } from '@storybook/react';
import { GripVertical, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { expect, fn, within } from 'storybook/test';
import { Chip, IconButton } from '../../designSystem';
import { ListRow, ListRowButton, ListRowText } from './ListRow';

const meta = {
    title: 'Components/ListRow',
    component: ListRow,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
} satisfies Meta<typeof ListRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const editAction = (
    <IconButton size="sm" aria-label="Edit">
        <Pencil />
    </IconButton>
);

/** A list page's frame around the rows, as the routes draw it. */
function ListFrame({ children }: { children: ReactNode }) {
    return <div style={{ maxInlineSize: '40rem', border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-sm)' }}>{children}</div>;
}

function TitleOnlyRow() {
    return (
        <ListFrame>
            <ListRow>
                <ListRowButton onActivate={fn()} data-testid="row">
                    <ListRowText primary="Call the dentist" />
                </ListRowButton>
            </ListRow>
        </ListFrame>
    );
}

/** Title only — the minimal row. */
export const TitleOnly: Story = {
    render: () => <TitleOnlyRow />,
};

/** Title, its chips and a muted detail line. */
export const WithSecondaryLine: Story = {
    render: () => (
        <ListFrame>
            <ListRow>
                <ListRowButton onActivate={fn()}>
                    <ListRowText
                        primary={
                            <>
                                <span>Renew passport</span>
                                <Chip label="Low" tone="success" />
                                <Chip label="15 min" variant="outline" />
                            </>
                        }
                        secondary="2 days ago"
                    />
                </ListRowButton>
            </ListRow>
        </ListFrame>
    ),
};

/** Row actions sit beside the row button, never inside it. */
export const WithActions: Story = {
    render: () => (
        <ListFrame>
            <ListRow actions={editAction}>
                <ListRowButton onActivate={fn()}>
                    <ListRowText primary="Buy milk" secondary="Just now" />
                </ListRowButton>
            </ListRow>
        </ListFrame>
    ),
};

/** A leading drag handle (ranked lists) — a sibling of the row button too. */
export const WithLeadingHandle: Story = {
    render: () => (
        <ListFrame>
            <ListRow actions={editAction}>
                <IconButton size="sm" aria-label="Reorder">
                    <GripVertical />
                </IconButton>
                <ListRowButton onActivate={fn()}>
                    <ListRowText primary="Draft the offsite agenda" secondary="Yesterday" />
                </ListRowButton>
            </ListRow>
        </ListFrame>
    ),
};

/** Several rows: a hairline divides them, none under the last. */
export const Divided: Story = {
    render: () => (
        <ListFrame>
            {['Alpha', 'Bravo', 'Charlie'].map((title, idx, all) => (
                <ListRow key={title} isDivided={idx < all.length - 1} actions={editAction}>
                    <ListRowButton onActivate={fn()}>
                        <ListRowText primary={title} secondary="3 days ago" />
                    </ListRowButton>
                </ListRow>
            ))}
        </ListFrame>
    ),
};

/**
 * A control inside the row button (the routine indicator is a button) — the reason the row button
 * is a `div role="button"`. The a11y addon flags the nested interactive control: known, MUI parity.
 */
export const WithInnerControl: Story = {
    render: () => (
        <ListFrame>
            <ListRow actions={editAction}>
                <ListRowButton onActivate={fn()}>
                    <ListRowText
                        primary={
                            <>
                                <span>Water the plants</span>
                                <Chip label="Routine" variant="outline" onClick={fn()} />
                            </>
                        }
                        secondary="Today"
                    />
                </ListRowButton>
            </ListRow>
        </ListFrame>
    ),
};

/** A long title wraps inside the row button and never pushes the actions out of view. */
export const LongTitle: Story = {
    render: () => (
        <ListFrame>
            <ListRow actions={editAction}>
                <ListRowButton onActivate={fn()}>
                    <ListRowText
                        primary="Write up the findings from the quarterly retrospective, including the three experiments we agreed to run next quarter and who owns each one"
                        secondary="Last week"
                    />
                </ListRowButton>
            </ListRow>
        </ListFrame>
    ),
};

/** Keyboard focus shows the inset ring. */
export const Focused: Story = {
    render: () => <TitleOnlyRow />,
    play: async ({ canvasElement }) => {
        const row = await within(canvasElement).findByTestId('row');
        row.focus();
        await expect(row).toHaveFocus();
    },
};
