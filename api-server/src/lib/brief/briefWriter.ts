import dayjs from 'dayjs';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import type { ItemBriefInterface } from '../../types/entities.js';
import { briefSourceHash, isPinnedOrigin } from '../briefSource.js';
import { loadBrief, upsertBriefRow, withBriefWriteLock } from '../itemBriefs.js';
import type { GeneratedBrief } from './briefModel.js';
import type { BriefSourceGuard } from './briefStaleMarker.js';

export type BriefWriteOutcome =
    /** Row upserted. */
    | { outcome: 'written'; brief: ItemBriefInterface }
    /** The item's title/notes changed since the generation was requested (or the item is gone); nothing written. */
    | { outcome: 'discarded_stale'; brief: null }
    /** A user/agent-authored brief exists and `force` was not set; nothing written. */
    | { outcome: 'pinned'; brief: ItemBriefInterface }
    /** The stored row already matches the current content; nothing written. */
    | { outcome: 'unchanged'; brief: ItemBriefInterface };

export interface SkippedBriefWrite {
    userId: string;
    itemId: string;
    /** Hash of the title + notes the decision was made FROM — the compare-and-set anchor. */
    sourceHash: string;
    /** Op-log provenance: `api:<tokenId>`, `server:brief-ondemand`, `server:brief-inline`, `server:brief-batch`, `server:brief-sweep-mine`. */
    deviceId: string;
    /** Replace a pinned (user/agent) brief. Only the explicit on-demand "Regenerate" sets it. */
    force?: boolean;
}

export interface ModelBriefWrite extends SkippedBriefWrite {
    generated: GeneratedBrief;
}

interface CurrentState {
    currentHash: string;
    /** The content the decision was made from — the guard on settling the `briefStale` marker. */
    source: BriefSourceGuard;
    existing: ItemBriefInterface | null;
}

/** The compare-and-set verdict: either an early outcome, or "go ahead" with the row to replace. */
type WriteDecision = { proceed: false; outcome: BriefWriteOutcome } | { proceed: true; existing: ItemBriefInterface | null; source: BriefSourceGuard };

/** Re-reads the item and its brief row under the lock so the compare-and-set sees fresh state. */
async function readCurrentState(userId: string, itemId: string): Promise<CurrentState | null> {
    const item = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!item) {
        return null;
    }
    const existing = await loadBrief(userId, itemId);
    return { currentHash: briefSourceHash(item.title, item.notes), source: { title: item.title, notes: item.notes, status: item.status }, existing };
}

/**
 * Shared CAS prologue: stale (content moved on, or item deleted) → discard; pinned without
 * `force` → refuse; otherwise proceed. `keepFresh` additionally leaves an already-current row
 * alone (the skip writer never downgrades a fresh model brief to a skipped marker).
 *
 * This is the SOURCE OF TRUTH for staleness and stays so: it re-reads the item and hashes its
 * title + notes for real. The `items.briefStale` marker is only a selection hint — it decides
 * which items a sweep looks at and can never wave a write through here.
 */
async function decideBriefWrite(write: SkippedBriefWrite, keepFresh: boolean): Promise<WriteDecision> {
    const state = await readCurrentState(write.userId, write.itemId);
    if (!state || state.currentHash !== write.sourceHash) {
        return { proceed: false, outcome: { outcome: 'discarded_stale', brief: null } };
    }
    const { existing } = state;
    if (existing && isPinnedOrigin(existing.origin) && !write.force) {
        return { proceed: false, outcome: { outcome: 'pinned', brief: existing } };
    }
    if (keepFresh && existing && existing.sourceHash === state.currentHash && !write.force) {
        return { proceed: false, outcome: { outcome: 'unchanged', brief: existing } };
    }
    return { proceed: true, existing, source: state.source };
}

/**
 * Retires the item from the sweep's candidate set now that a row exists for exactly this content.
 * Runs after the row is persisted, so a crash in between leaves the marker set and the next sweep
 * simply re-settles it — the safe direction.
 */
async function settleBriefStale(write: SkippedBriefWrite, source: BriefSourceGuard): Promise<void> {
    await itemsDAO.clearBriefStale(write.itemId, write.userId, source);
}

/** The identity + timestamp fields every generated row shares; the caller adds text/origin/model. */
function buildRowBase(write: SkippedBriefWrite, existing: ItemBriefInterface | null) {
    const now = dayjs().toISOString();
    return {
        _id: write.itemId,
        user: write.userId,
        itemId: write.itemId,
        sourceHash: write.sourceHash,
        generatedTs: now,
        createdTs: existing?.createdTs ?? now,
        updatedTs: now,
    };
}

/**
 * Compare-and-set write of a model-generated brief. Discards (rather than writes a lie) when the
 * item's content moved on since generation — the next sweep reselects it — and refuses to
 * replace an authored brief unless `force`.
 */
export function writeModelBrief(write: ModelBriefWrite): Promise<BriefWriteOutcome> {
    return withBriefWriteLock(write.itemId, async () => {
        const decision = await decideBriefWrite(write, false);
        if (!decision.proceed) {
            return decision.outcome;
        }
        const snapshot: ItemBriefInterface = {
            ...buildRowBase(write, decision.existing),
            text: write.generated.text,
            origin: 'model',
            model: write.generated.model,
        };
        await upsertBriefRow({ userId: write.userId, snapshot, existing: decision.existing, deviceId: write.deviceId });
        await settleBriefStale(write, decision.source);
        return { outcome: 'written', brief: snapshot };
    });
}

/**
 * Records the skip decision (`text: null, origin: 'skipped'`) so the sweep stops reselecting an
 * item whose notes are too short. Never overwrites a pinned brief (unless `force`) and never
 * touches a row that is already fresh for the current content — a fresh model brief stays.
 */
export function writeSkippedBrief(write: SkippedBriefWrite): Promise<BriefWriteOutcome> {
    return withBriefWriteLock(write.itemId, async () => {
        const decision = await decideBriefWrite(write, true);
        if (!decision.proceed) {
            return decision.outcome;
        }
        const snapshot: ItemBriefInterface = { ...buildRowBase(write, decision.existing), text: null, origin: 'skipped' };
        await upsertBriefRow({ userId: write.userId, snapshot, existing: decision.existing, deviceId: write.deviceId });
        await settleBriefStale(write, decision.source);
        return { outcome: 'written', brief: snapshot };
    });
}
