import type { BriefState } from '../../lib/briefSource';

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
