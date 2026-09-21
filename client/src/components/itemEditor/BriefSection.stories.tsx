import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import type { BriefState } from '../../lib/briefSource';
import type { BriefOrigin } from '../../types/MyDB';
import { BriefSection } from './BriefSection';
import type { BriefGeneration } from './useBriefGeneration';

/** A generation state machine frozen in one state — the button/confirm/snackbar render from it alone. */
function makeGeneration(overrides: Partial<BriefGeneration> = {}): BriefGeneration {
    return {
        phase: 'idle',
        isOnline: true,
        notice: null,
        dismissNotice: fn(),
        requestGenerate: fn(),
        confirmReplace: fn(),
        keepBrief: fn(),
        ...overrides,
    };
}

const meta = {
    title: 'Components/BriefSection',
    component: BriefSection,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    // Required by StoryObj type even when `render` overrides the component entirely.
    args: { value: '', state: 'none', onChange: fn(), onCommit: fn(), generation: makeGeneration() },
} satisfies Meta<typeof BriefSection>;

export default meta;
type Story = StoryObj<typeof meta>;

interface ControlledProps {
    initial: string;
    state: BriefState;
    /** Only read for `state="declined"`, where it picks which caption the muted line shows. */
    origin?: BriefOrigin;
    variant?: 'field' | 'line';
    generation?: BriefGeneration;
}

function ControlledBriefSection({ initial, state, origin, variant, generation = makeGeneration() }: ControlledProps) {
    const [value, setValue] = useState(initial);
    return (
        <BriefSection
            value={value}
            state={state}
            origin={origin}
            onChange={setValue}
            onCommit={fn()}
            generation={generation}
            {...(variant ? { variant } : {})}
        />
    );
}

const PINNED_TEXT = 'Renew the passport before the June trip — form is half filled.';

/** No brief yet — the empty field with its placeholder, no clear button, and the sparkle "Generate brief" button. */
export const Empty: Story = {
    render: () => <ControlledBriefSection initial="" state="none" />,
};

/** A brief whose source hash still matches the item's title + notes. The sparkle now reads "Regenerate brief". */
export const Fresh: Story = {
    render: () => <ControlledBriefSection initial={PINNED_TEXT} state="fresh" />,
};

/** A user-authored brief whose notes moved on since it was written — the muted marker shows. */
export const PinnedStale: Story = {
    render: () => <ControlledBriefSection initial={PINNED_TEXT} state="pinnedStale" />,
};

/** Generation in flight: the sparkle becomes a spinner and the button is disabled. */
export const Generating: Story = {
    render: () => <ControlledBriefSection initial="" state="none" generation={makeGeneration({ phase: 'loading' })} />,
};

/** Regenerate over an authored brief: the inline "Replace your brief?" confirm with Replace / Keep. */
export const ReplaceConfirm: Story = {
    render: () => <ControlledBriefSection initial={PINNED_TEXT} state="fresh" generation={makeGeneration({ phase: 'confirm' })} />,
};

/** Offline: the button is disabled and its tooltip says to connect first. */
export const Offline: Story = {
    render: () => <ControlledBriefSection initial="" state="none" generation={makeGeneration({ isOnline: false })} />,
};

/**
 * After a run that wrote nothing because the notes are too short: the snackbar carries the event
 * and the row it wrote renders as `declined`, so both are on screen at once — this story exists
 * to keep that pairing under review.
 */
export const SkippedNotice: Story = {
    render: () => (
        <ControlledBriefSection
            initial=""
            state="declined"
            origin="skipped"
            generation={makeGeneration({ notice: 'Notes are too short for a brief — the title already says it' })}
        />
    ),
};

/** A retry whose model declined again: the caption is unchanged, so the snackbar is the only feedback. */
export const DeclinedNotice: Story = {
    render: () => (
        <ControlledBriefSection
            initial=""
            state="declined"
            origin="model"
            generation={makeGeneration({ notice: 'Nothing in the notes worth condensing — no brief written' })}
        />
    ),
};

/**
 * The model read the notes and judged there was nothing worth condensing. The field stays
 * editable (typing a brief over it replaces the row) and Generate stays live for a retry after a
 * notes edit — only the muted caption says why the field is empty.
 */
export const DeclinedByModel: Story = {
    render: () => <ControlledBriefSection initial="" state="declined" origin="model" />,
};

/** The notes were under the skip threshold, so no model call was made — the title already says it. */
export const DeclinedAsSkipped: Story = {
    render: () => <ControlledBriefSection initial="" state="declined" origin="skipped" />,
};

/**
 * The same declined row once the user starts typing their own brief: the caption is gone from the
 * first keystroke (the stored row is still declined — only the live field value decides this).
 * Backspacing to empty brings it back.
 */
export const DeclinedBeingOverwritten: Story = {
    render: () => <ControlledBriefSection initial="Passport before the June trip" state="declined" origin="model" />,
};

/** Review presentation: the brief reads as a plain line with the sparkle at its end; clicking the line opens the field in place. */
export const ReviewLine: Story = {
    render: () => <ControlledBriefSection initial={PINNED_TEXT} state="fresh" variant="line" />,
};

/** Review presentation with the stale marker under the line. */
export const ReviewLinePinnedStale: Story = {
    render: () => <ControlledBriefSection initial={PINNED_TEXT} state="pinnedStale" variant="line" />,
};

/** Review presentation mid-confirm: the Replace / Keep row sits under the line. */
export const ReviewLineReplaceConfirm: Story = {
    render: () => <ControlledBriefSection initial={PINNED_TEXT} state="fresh" variant="line" generation={makeGeneration({ phase: 'confirm' })} />,
};
