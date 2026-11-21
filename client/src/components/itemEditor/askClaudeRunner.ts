import type { ServerClaudeAskSnapshot } from '../../api/claudeRoutineApi';
import { type AskErrorView, describeAskError } from './askClaudeLogic';

/** The side effects one ask needs, handed in so the run itself stays a plain testable function. */
export interface AskClaudeRunPorts {
    /**
     * Commits any debounced title/notes edit and pushes it FIRST: the server builds Claude's
     * request from ITS copy of the item, so text still sitting in the autosave would never reach
     * Claude.
     */
    flushItemText: () => Promise<void>;
    ask: (prompt: string) => Promise<ServerClaudeAskSnapshot>;
    /** Lands the returned row locally (LWW) and refreshes the provider. */
    store: (ask: ServerClaudeAskSnapshot) => Promise<void>;
}

export type AskClaudeSettlement = { kind: 'started'; sessionUrl: string } | { kind: 'failed'; error: AskErrorView };

/** One ask round trip: flush → start the Claude routine → store the recorded row. */
export async function runAskClaude(prompt: string, ports: AskClaudeRunPorts): Promise<AskClaudeSettlement> {
    try {
        await ports.flushItemText();
        const ask = await ports.ask(prompt.trim());
        await ports.store(ask);
        return { kind: 'started', sessionUrl: ask.sessionUrl };
    } catch (err) {
        return { kind: 'failed', error: describeAskError(err) };
    }
}
