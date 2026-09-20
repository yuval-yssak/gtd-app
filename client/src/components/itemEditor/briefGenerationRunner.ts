import type { GenerateBriefResult, ServerItemBriefSnapshot } from '../../api/briefApi';
import { describeGenerateError, describeGenerateOutcome, isBriefPinnedError } from './briefSectionLogic';

/** The side effects one generation run needs, handed in so the run itself stays a plain testable function. */
export interface BriefRunPorts {
    /**
     * Commits any debounced title/notes edit and drains the sync queue FIRST: the server generates
     * from ITS copy of the item, so text still sitting in the editor's autosave would produce a
     * brief of the previous notes (or a false "too short" skip) stamped with a hash that never
     * matches what the user is looking at.
     */
    flushItemText: () => Promise<void>;
    generate: (force: boolean) => Promise<GenerateBriefResult>;
    /** Lands the returned row locally (LWW) and refreshes the provider. */
    store: (brief: ServerItemBriefSnapshot) => Promise<void>;
}

/**
 * - `silent`  — a brief was written; the new line is the feedback.
 * - `notice`  — nothing (or nothing useful) was written; tell the user why.
 * - `confirm` — the server refused without `force` (a pinned brief the gate did not know about).
 */
export type BriefRunSettlement = { kind: 'silent' } | { kind: 'notice'; text: string } | { kind: 'confirm' };

function settleOutcome(result: GenerateBriefResult): BriefRunSettlement {
    const text = describeGenerateOutcome(result.outcome);
    return text === null ? { kind: 'silent' } : { kind: 'notice', text };
}

function settleFailure(err: unknown): BriefRunSettlement {
    return isBriefPinnedError(err) ? { kind: 'confirm' } : { kind: 'notice', text: describeGenerateError(err) };
}

/** One generation round trip: flush → generate → store the returned row → decide what to tell the user. */
export async function runBriefGeneration(force: boolean, ports: BriefRunPorts): Promise<BriefRunSettlement> {
    try {
        await ports.flushItemText();
        const result = await ports.generate(force);
        if (result.brief !== null) {
            await ports.store(result.brief);
        }
        return settleOutcome(result);
    } catch (err) {
        return settleFailure(err);
    }
}
