import { BriefApiError, type GenerateBriefOutcome } from '../../api/briefApi';
import { type BriefState, isPinnedOrigin } from '../../lib/briefSource';
import type { BriefOrigin, StoredItem, StoredItemBrief } from '../../types/MyDB';

export const BRIEF_LABEL = 'Brief';
/** Names the open field + its Clear/Done buttons as one group; distinct from BRIEF_LABEL so a label query still finds only the field. */
export const BRIEF_EDITOR_LABEL = 'Brief editor';
export const BRIEF_PLACEHOLDER = 'One line for the weekly review';
/** Read view of an empty brief on an open item: says the brief is not the user's job, so the pencil reads as optional. */
export const BRIEF_EMPTY_HINT = 'No brief yet — one is written automatically';
/** Read view of an empty brief on a done/trashed item, which the sweep never briefs. */
export const BRIEF_EMPTY_CLOSED_HINT = 'No brief';

/**
 * Mirrors the server's open-items-only rule — an allowlist, like `LIVE_STATUSES` in
 * api-server/src/lib/brief/briefScope.ts, so a new status stays unbriefed on both sides until added.
 */
const BRIEFABLE_STATUSES: ReadonlySet<StoredItem['status']> = new Set(['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe']);

export function isBriefableItemStatus(status: StoredItem['status']): boolean {
    return BRIEFABLE_STATUSES.has(status);
}

/**
 * The muted text standing in for an empty brief in the read view. Blank for `declined`: that row
 * already has its own caption (`describeDeclinedBrief`) explaining why there is no brief.
 */
export function describeEmptyBrief(state: BriefState, isBriefable: boolean): string {
    if (state === 'declined') {
        return '';
    }
    return isBriefable ? BRIEF_EMPTY_HINT : BRIEF_EMPTY_CLOSED_HINT;
}

/**
 * Shown for as long as the brief field is open. Typing a brief pins it, which silently changes how
 * the item behaves later — it must be said up front, not discovered when the notes move on.
 */
export const BRIEF_PINNED_NOTICE =
    'A brief you write is pinned: it stays exactly as written, even when the title or notes change. To unpin it, click Regenerate brief (✨) and choose Replace.';
/** Shown under a pinned (user/agent) brief whose source title/notes moved on since it was written. */
export const BRIEF_STALE_MARKER = 'Notes changed since this brief was written';

/** `declined` + `model`: the model read the notes and judged there was nothing worth condensing. */
export const BRIEF_DECLINED_MODEL_NOTE = 'No brief — nothing in the notes to summarise';
/** `declined` + `skipped`: the notes were under the skip threshold, so no model call was made. */
export const BRIEF_DECLINED_SKIPPED_NOTE = 'No brief — the title already says it';

/**
 * Snackbar line for a run whose model DECLINED (the server reports that as `written` with a
 * `text: null` row). Without it a retry on an already-`declined` item changes nothing on screen —
 * same caption, same empty field, no notice — which is indistinguishable from a broken button.
 * Worded as an event ("wrote no brief") rather than a state, so it does not simply re-read the
 * caption sitting directly above it.
 */
export const BRIEF_DECLINED_NOTICE = 'Nothing in the notes worth condensing — no brief written';

/**
 * The muted caption that stands in for an empty Brief field on a `declined` row. Both text-less
 * origins reach this; the distinction is WHY nothing was written, which is what the user cannot
 * otherwise tell apart from a broken or still-loading feature.
 *
 * `declined` implies a stored row, so the real host always supplies `origin`; without one it still
 * answers rather than render nothing — a missing prop must not silently restore the blank field
 * this caption exists to replace.
 */
export function describeDeclinedBrief(origin: BriefOrigin | undefined): string {
    return origin === 'skipped' ? BRIEF_DECLINED_SKIPPED_NOTE : BRIEF_DECLINED_MODEL_NOTE;
}

/**
 * Whether the declined caption is on show, given the LIVE field value — not the stored row alone.
 * The caption explains an empty Brief field; the moment the user types, the field is theirs and
 * the explanation is stale, so it must go on the first keystroke rather than on blur or save.
 *
 * Keyed on the field value only (no `isEditing` flag), which settles both edges deliberately:
 * focusing an empty field KEEPS the caption — with nothing typed yet it reads as a hint, and
 * hiding it on a stray focus would lose that for nothing — while backspacing back to empty brings
 * it back at the last character. It cannot flicker mid-backspace: any remaining text is non-empty,
 * so the caption stays hidden until the field is genuinely empty again.
 */
export function isDeclinedNoteVisible({ state, fieldValue }: { state: BriefState; fieldValue: string }): boolean {
    return state === 'declined' && fieldValue.trim().length === 0;
}

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
 *
 * `declined` is deliberately NOT brief-first: there is no brief LINE to lead with, only a one-line
 * "no brief, and here is why" caption, so the notes preview must stay on show as it does for `none`.
 */
export function isBriefFirst(presentation: EditorPresentation, isShowBriefsOn: boolean, state: BriefState): boolean {
    return presentation === 'review' && isShowBriefsOn && (state === 'fresh' || state === 'pinnedStale');
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

/**
 * The snackbar line for a completed generation keyed on the OUTCOME alone — `null` when a brief
 * was written, because the new line is its own feedback. `written` also covers a model decline
 * (`text: null`), which is NOT self-evident; `settleOutcome` inspects the row for that case
 * before falling through to here.
 */
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

/**
 * The snackbar line for a failed generation, keyed on the server's status (network throws read as
 * generic). Status branches come first only because no `code` currently shares 429 or 503 — a
 * future code that does would be shadowed by them, so move the `code` checks above if you add one.
 */
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
    // Named rather than left to the generic line: the user can see the item is done/trashed, so a
    // bare "could not generate" reads as a bug instead of the deliberate rule it is. Shorter than
    // the server's wording on purpose — it states the RULE, and the status chip already shows why.
    if (err.code === 'brief_not_applicable') {
        return 'Briefs are only generated for open items';
    }
    return 'Could not generate a brief';
}
