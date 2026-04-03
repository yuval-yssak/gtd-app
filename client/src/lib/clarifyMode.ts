export type InlineClarifyMode = 'dialog' | 'expand' | 'popover' | 'instant' | 'page';

export const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';

export const CLARIFY_MODES = new Set<string>(['dialog', 'expand', 'popover', 'instant', 'page']);

// Validates the raw localStorage value — an invalid or missing value falls back to 'dialog'
// rather than reaching onInlineAction with an unrecognised mode and silently doing nothing.
export function parseClarifyMode(raw: string | null): InlineClarifyMode {
    if (raw !== null && CLARIFY_MODES.has(raw)) return raw as InlineClarifyMode;
    return 'dialog';
}
