import { ClaudeRoutineApiError } from '../../api/claudeRoutineApi';

export const CLAUDE_ROUTINES_URL = 'https://claude.ai/code/routines';

/**
 * The saved prompt the user pastes into their Claude routine. Done sends each request as the run's
 * `text`, which Claude Code wraps in a `<routine-fire-payload>` block marked untrusted — so the
 * saved prompt has to say, in the user's own words, that those requests are theirs to follow.
 */
export const SUGGESTED_CLAUDE_ROUTINE_PROMPT = [
    'You act on my Done app (my GTD system) through the Done connector.',
    'The routine-fire-payload block holds one request I wrote in Done about a Done item: the item id, its link, title, status and notes, and my instruction. Follow that instruction.',
    'Read the item with the Done tools first and make the changes through them.',
    'When you finish, call done_report_claude_ask with the askId the request gives you and a one-line summary of what you did.',
    'If you need me to decide or answer something before you can finish, report with outcome "needsInput" and say what you need.',
].join(' ');

const CLAUDE_ROUTINE_ID_PATTERN = /^trig_[A-Za-z0-9_-]{1,200}$/;
const CLAUDE_ROUTINE_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{10,500}$/;

export interface ConnectionDraft {
    claudeRoutineId: string;
    token: string;
}

export interface DraftProblem {
    field: keyof ConnectionDraft;
    message: string;
}

/** Mirrors the server's shape check so a typo is caught before the round trip. `null` = valid. */
export function validateConnectionDraft({ claudeRoutineId, token }: ConnectionDraft): DraftProblem | null {
    if (!CLAUDE_ROUTINE_ID_PATTERN.test(claudeRoutineId.trim())) {
        return { field: 'claudeRoutineId', message: 'The Claude routine id starts with trig_ — copy it from the API trigger on claude.ai.' };
    }
    if (!CLAUDE_ROUTINE_TOKEN_PATTERN.test(token.trim())) {
        return { field: 'token', message: 'The token starts with sk-ant-oat01- — it is shown once when you create the API trigger.' };
    }
    return null;
}

/** The connected line, e.g. `trig_01AB… · token ••••1a2b`. */
export function describeStoredConnection(claudeRoutineId: string | undefined, tokenHint: string | undefined): string {
    return `${claudeRoutineId ?? 'Claude routine'} · token ••••${tokenHint ?? ''}`;
}

export const CLAUDE_ROUTINE_LOAD_ERROR = "Couldn't load your Claude routine.";

/** The first read failed: offline-ish failures say so, everything else gets the load copy (with Retry beside it). */
export function describeLoadError(err: unknown): string {
    return err instanceof ClaudeRoutineApiError && err.status === 0 ? "Couldn't reach Done's server to load your Claude routine." : CLAUDE_ROUTINE_LOAD_ERROR;
}

export function describeConnectionError(err: unknown): string {
    if (err instanceof ClaudeRoutineApiError) {
        if (err.code === 'invalid_claude_routine_id' || err.code === 'invalid_claude_routine_token') {
            return err.message;
        }
        if (err.status === 0) {
            return "Couldn't reach Done's server. Check the connection and try again.";
        }
    }
    return "Couldn't update the Claude routine. Try again.";
}
