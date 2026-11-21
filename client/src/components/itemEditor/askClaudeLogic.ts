import { ClaudeRoutineApiError, type ClaudeRoutineErrorCode } from '../../api/claudeRoutineApi';
import type { StoredClaudeAsk, StoredItem } from '../../types/MyDB';

export const ASK_CLAUDE_LABEL = 'Ask Claude';
export const ASK_CLAUDE_PROMPT_LABEL = 'Ask Claude about this item';
export const ASK_CLAUDE_PLACEHOLDER = 'e.g. Read the linked ticket and rewrite the title so it says what to do';
export const ASK_CLAUDE_OFFLINE_TOOLTIP = 'Asking Claude needs a connection';
export const ASK_CLAUDE_EMPTY_TOOLTIP = 'Write what Claude should do first';
export const ASK_CLAUDE_STARTED_NOTICE = 'Claude is working on it';
export const ASK_CLAUDE_WAITING_LABEL = "Waiting for Claude's result";
export const ASK_CLAUDE_OPEN_SESSION_LABEL = 'Open session';
/** Matches the server's prompt ceiling (`CLAUDE_ASK_PROMPT_MAX_CHARS`). */
export const ASK_CLAUDE_PROMPT_MAX_CHARS = 4_000;
/** The counter appears once the prompt is this close to the ceiling. */
const PROMPT_COUNTER_THRESHOLD = 3_500;

/** `3612 / 4000` counter text near the limit, `null` while the prompt is comfortably short. */
export function describePromptCounter(prompt: string): string | null {
    return prompt.length >= PROMPT_COUNTER_THRESHOLD ? `${prompt.length} / ${ASK_CLAUDE_PROMPT_MAX_CHARS}` : null;
}

/** Only a claude.ai https link is rendered as a link — the URL came off the wire. */
export function isClaudeSessionLink(url: string): boolean {
    return url.startsWith('https://claude.ai/');
}
/** History rows shown before "Show all". */
export const ASK_HISTORY_PREVIEW_COUNT = 3;

/** A trashed item is out of play — nothing to ask Claude about. */
export function isAskClaudeAvailable(status: StoredItem['status']): boolean {
    return status !== 'trash';
}

/** This item's asks, newest first. */
export function asksForItem(asks: readonly StoredClaudeAsk[], itemId: string): StoredClaudeAsk[] {
    return asks.filter((ask) => ask.itemId === itemId).sort((a, b) => b.createdTs.localeCompare(a.createdTs));
}

/** The rows the history shows: a short preview unless the user asked for all of them. */
export function visibleAsks(asks: readonly StoredClaudeAsk[], isExpanded: boolean): readonly StoredClaudeAsk[] {
    return isExpanded ? asks : asks.slice(0, ASK_HISTORY_PREVIEW_COUNT);
}

export type AskResultTone = 'completed' | 'needsInput' | 'waiting';

/** The status line under a history row — Claude's report, or the waiting hint until there is one. */
export function describeAskResult(ask: StoredClaudeAsk): { tone: AskResultTone; text: string } {
    if (!ask.result) {
        return { tone: 'waiting', text: ASK_CLAUDE_WAITING_LABEL };
    }
    if (ask.result.outcome === 'needsInput') {
        return { tone: 'needsInput', text: `Needs your input: ${ask.result.summary}` };
    }
    return { tone: 'completed', text: `✓ ${ask.result.summary}` };
}

export interface AskButtonView {
    isDisabled: boolean;
    /** Why the button is disabled — `null` when it is enabled. */
    tooltip: string | null;
}

export function describeAskButton({ isOnline, isSending, prompt }: { isOnline: boolean; isSending: boolean; prompt: string }): AskButtonView {
    if (!isOnline) {
        return { isDisabled: true, tooltip: ASK_CLAUDE_OFFLINE_TOOLTIP };
    }
    if (!prompt.trim()) {
        return { isDisabled: true, tooltip: ASK_CLAUDE_EMPTY_TOOLTIP };
    }
    return { isDisabled: isSending, tooltip: null };
}

/** Mod+Enter in the prompt sends it (and must not also reach the editor's Save shortcut). */
export function isSubmitChord(event: { key: string; metaKey: boolean; ctrlKey: boolean; repeat: boolean }): boolean {
    return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat;
}

/** A failed ask as the section shows it; `isSettingsFix` adds a link to Settings. */
export interface AskErrorView {
    message: string;
    isSettingsFix: boolean;
}

const ERROR_MESSAGES: Partial<Record<ClaudeRoutineErrorCode, AskErrorView>> = {
    claude_routine_not_connected: { message: 'Connect a Claude routine in Settings to ask Claude from Done.', isSettingsFix: true },
    claude_routine_token_rejected: { message: 'Claude rejected the Claude routine token. Save a new token in Settings.', isSettingsFix: true },
    claude_routine_not_found: { message: 'Claude has no Claude routine with the saved id. Check it in Settings.', isSettingsFix: true },
    claude_routine_unavailable: { message: 'The Claude routine refused to start — it may be paused on claude.ai.', isSettingsFix: false },
    claude_ask_in_flight: { message: 'Claude was just asked about this item. Give it a few seconds.', isSettingsFix: false },
    claude_routine_unreachable: { message: "Claude couldn't be reached. Try again in a moment.", isSettingsFix: false },
    // Done stopped waiting, but the server may still have started the session and recorded it.
    timeout: { message: 'Claude may already be starting — check the history below in a moment.', isSettingsFix: false },
    invalid_prompt: { message: `Write between 1 and ${ASK_CLAUDE_PROMPT_MAX_CHARS} characters.`, isSettingsFix: false },
    not_found: { message: 'This item is no longer on the server.', isSettingsFix: false },
};

const FALLBACK_ERROR: AskErrorView = { message: "Couldn't ask Claude. Try again.", isSettingsFix: false };

export function describeAskError(err: unknown): AskErrorView {
    if (!(err instanceof ClaudeRoutineApiError)) {
        return FALLBACK_ERROR;
    }
    if (err.code === 'claude_routine_rate_limited') {
        const wait = err.retryAfterSeconds === undefined ? 'a little while' : `${err.retryAfterSeconds} seconds`;
        return { message: `The Claude routine was started too often. Try again in ${wait}.`, isSettingsFix: false };
    }
    const known = err.code && ERROR_MESSAGES[err.code];
    if (known) {
        return known;
    }
    return err.status === 0 ? { message: "Couldn't reach Done's server. Check the connection and try again.", isSettingsFix: false } : FALLBACK_ERROR;
}
