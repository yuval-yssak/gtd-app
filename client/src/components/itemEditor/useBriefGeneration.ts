import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { generateBrief } from '../../api/briefApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { applyServerItemBrief } from '../../db/syncHelpers';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useOnline } from '../../hooks/useOnline';
import type { MyDB, StoredItem, StoredItemBrief } from '../../types/MyDB';
import { type BriefRunSettlement, runBriefGeneration } from './briefGenerationRunner';
import { type BriefGenerationPhase, isReplaceConfirmNeeded } from './briefSectionLogic';

/** What the Generate button needs from its host: the phase machine, connectivity, and the feedback line. */
export interface BriefGeneration {
    phase: BriefGenerationPhase;
    isOnline: boolean;
    /** Snackbar text for the last completed/failed run; `null` once dismissed or when a brief was written. */
    notice: string | null;
    dismissNotice: () => void;
    /** First click: asks before replacing an authored brief (`fieldValue` is the field's current text), otherwise generates. */
    requestGenerate: (fieldValue: string) => void;
    /** "Replace" in the inline confirm → generate with `force`. */
    confirmReplace: () => void;
    /** "Keep" in the inline confirm → back to idle, nothing written. */
    keepBrief: () => void;
}

interface BriefGenerationTarget {
    item: Pick<StoredItem, '_id' | 'userId'>;
    brief: StoredItemBrief | undefined;
    /** See `BriefRunPorts.flushItemText` — the host owns the editor's autosave, so it supplies the flush. */
    flushItemText: () => Promise<void>;
}

/**
 * Drives the on-demand "Generate brief" button for one item. The orchestration lives in
 * `runBriefGeneration` (plain, unit-tested); this hook only owns the phase/notice state and the
 * ports: owner-session pinning, the LWW local apply, and the provider refresh.
 */
export function useBriefGeneration(db: IDBPDatabase<MyDB>, { item, brief, flushItemText }: BriefGenerationTarget): BriefGeneration {
    const { withOwnerSession, refreshItemBriefs } = useAppData();
    const isOnline = useOnline();
    const isMounted = useIsMounted();
    const [phase, setPhase] = useState<BriefGenerationPhase>('idle');
    const [notice, setNotice] = useState<string | null>(null);

    async function run(force: boolean) {
        setPhase('loading');
        const settlement = await runBriefGeneration(force, {
            flushItemText,
            // Pivot to the item's OWNER: the endpoint resolves the acting user from the session
            // cookie, so a cross-account item would 404 under the ambient session.
            generate: (isForced) => withOwnerSession(item.userId, () => generateBrief(item._id, { force: isForced })),
            store: async (row) => {
                await applyServerItemBrief(db, row);
                await refreshItemBriefs();
            },
        });
        // The store above already ran; only the state setters are skipped after unmount.
        if (isMounted()) {
            applySettlement(settlement);
        }
    }

    function applySettlement(settlement: BriefRunSettlement) {
        setPhase(settlement.kind === 'confirm' ? 'confirm' : 'idle');
        setNotice(settlement.kind === 'notice' ? settlement.text : null);
    }

    function requestGenerate(fieldValue: string) {
        if (isReplaceConfirmNeeded(fieldValue, brief)) {
            setPhase('confirm');
            return;
        }
        void run(false);
    }

    return {
        phase,
        isOnline,
        notice,
        dismissNotice: () => setNotice(null),
        requestGenerate,
        confirmReplace: () => void run(true),
        keepBrief: () => setPhase('idle'),
    };
}
