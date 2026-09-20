import { BriefApiError, type GenerateBriefOutcome } from '../../api/briefApi';
import { type BriefState, isPinnedOrigin } from '../../lib/briefSource';
import type { StoredItemBrief } from '../../types/MyDB';

export const BRIEF_LABEL = 'Brief';
export const BRIEF_PLACEHOLDER = 'One line for the weekly review';
/** Shown under a pinned (user/agent) brief whose source title/notes moved on since it was written. */
export const BRIEF_STALE_MARKER = 'Notes changed since this brief was written';

export type BriefCommit = { kind: 'noop' } | { kind: 'clear' } | { kind: 'set'; text: string };

/**
 * What a blur/Enter on the brief field should persist. Compared against the SEED (the last
 * saved/merged value) so retyping the saved text writes nothing; an emptied field clears the
 * row rather than storing ''.
 */
export function decideBriefCommit(fieldValue: string, seedValue: string): BriefCommit {
    const text = fieldValue.trim();
    if (text === seedValue) {
        return { kind: 'noop' };
    }
    return text ? { kind: 'set', text } : { kind: 'clear' };
}

export type EditorPresentation = 'edit' | 'review';

/**
 * Review presentation only: the card leads with the brief line and folds the notes behind a
 * disclosure — but only when there is a brief worth showing AND the user has not turned briefs
 * off. Otherwise the editor renders exactly as it does everywhere else (notes preview).
 */
export function isBriefFirst(presentation: EditorPresentation, isShowBriefsOn: boolean, state: BriefState): boolean {
    return presentation === 'review' && isShowBriefsOn && state !== 'none';
}

// ── Generate / Regenerate button ─────────────────────────────────────────────

export const GENERATE_BRIEF_LABEL = 'Generate brief';
export const REGENERATE_BRIEF_LABEL = 'Regenerate brief';
export const GENERATE_BRIEF_OFFLINE_TOOLTIP = 'Connect to generate a brief';
export const REPLACE_BRIEF_PROMPT = 'Replace your brief?';

export type BriefGenerationPhase = 'idle' | 'loading' | 'confirm';

type BriefRowForGeneration = Pick<StoredItemBrief, 'origin' | 'text'> | undefined;

/**
 * Whether generating would overwrite something the user (or an agent) authored, so the button
 * must ask first. Two sources count: a stored pinned row, and text sitting in the field that is
 * not the stored brief (typed but not yet committed — the click's blur commits it as a user brief
 * an instant before the request goes out, so the server would refuse without `force`).
 */
export function isReplaceConfirmNeeded(fieldValue: string, brief: BriefRowForGeneration): boolean {
    const fieldText = fieldValue.trim();
    if (!fieldText) {
        return false;
    }
    if (brief && isPinnedOrigin(brief.origin) && brief.text !== null) {
        return true;
    }
    return fieldText !== (brief?.text ?? '');
}

export interface GenerateButtonView {
    label: string;
    tooltip: string;
    isDisabled: boolean;
}

/** The icon button's label/tooltip/enablement for a given pinned-ness, connectivity and phase. */
export function describeGenerateButton({
    isRegenerate,
    isOnline,
    phase,
}: {
    isRegenerate: boolean;
    isOnline: boolean;
    phase: BriefGenerationPhase;
}): GenerateButtonView {
    const label = isRegenerate ? REGENERATE_BRIEF_LABEL : GENERATE_BRIEF_LABEL;
    if (!isOnline) {
        return { label, tooltip: GENERATE_BRIEF_OFFLINE_TOOLTIP, isDisabled: true };
    }
    return { label, tooltip: `${label} with AI`, isDisabled: phase !== 'idle' };
}

/** The snackbar line for a completed generation — `null` when a brief was written (the line itself is the feedback). */
export function describeGenerateOutcome(outcome: GenerateBriefOutcome): string | null {
    switch (outcome) {
        case 'written':
            return null;
        case 'skipped':
            return 'Notes are too short for a brief — the title already says it';
        case 'discarded_stale':
            return 'Notes changed while generating; try again';
    }
}

function describeSeconds(seconds: number): string {
    return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

export function isBriefPinnedError(err: unknown): boolean {
    return err instanceof BriefApiError && err.code === 'brief_pinned';
}

/** The snackbar line for a failed generation, keyed on the server's status (network throws read as generic). */
export function describeGenerateError(err: unknown): string {
    if (!(err instanceof BriefApiError)) {
        return 'Could not generate a brief';
    }
    if (err.status === 429) {
        return err.retryAfterSeconds === undefined
            ? 'Too many brief generations, try again shortly'
            : `Too many brief generations, try again in ${describeSeconds(err.retryAfterSeconds)}`;
    }
    if (err.status === 503) {
        return 'AI brief generation is not configured on this server';
    }
    return 'Could not generate a brief';
}
