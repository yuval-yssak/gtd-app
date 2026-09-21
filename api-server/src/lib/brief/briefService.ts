import itemsDAO from '../../dataAccess/itemsDAO.js';
import type { ItemBriefInterface, ItemInterface } from '../../types/entities.js';
import { briefSourceHash, isPinnedOrigin, shouldSkipBrief } from '../briefSource.js';
import { loadBrief } from '../itemBriefs.js';
import { generateBriefText } from './briefModel.js';
import { isBriefableStatus } from './briefScope.js';
import { type BriefWriteOutcome, writeModelBrief, writeSkippedBrief } from './briefWriter.js';

export interface GenerateBriefParams {
    userId: string;
    itemId: string;
    /** Op-log provenance for the resulting write. */
    deviceId: string;
    /** Replace a user/agent-authored brief. */
    force: boolean;
}

export type GenerateBriefResult =
    | { outcome: 'not_found'; brief: null }
    /** The item is `done` or `trash` — briefs are a Weekly-Review affordance and it is never reviewed. */
    | { outcome: 'not_briefable'; brief: null }
    /** The skip rule applied (notes too short): a `skipped` row was written, or one was already current. */
    | { outcome: 'skipped'; brief: ItemBriefInterface }
    // `unchanged` is a skip-writer detail folded into `skipped` here; it never reaches callers.
    | Exclude<BriefWriteOutcome, { outcome: 'unchanged' }>;

/** An item read back from Mongo — `_id` is always present, unlike on a create payload. */
export type PersistedItem = ItemInterface & { _id: string };

export interface BriefTarget {
    item: PersistedItem;
    brief: ItemBriefInterface | null;
}

/**
 * What a generation request will do, decided from one read of the item + its row BEFORE any
 * model call, so a pinned brief costs nothing and callers charge the per-user cap only for
 * `model` plans. The writer re-checks everything under its lock; this is the cheap first pass.
 */
export type BriefPlan =
    | { kind: 'not_found' }
    /** The item is `done` or `trash`: briefs serve the Weekly Review, which never shows it. */
    | { kind: 'not_briefable'; item: PersistedItem }
    | { kind: 'pinned'; brief: ItemBriefInterface }
    | { kind: 'skip'; item: PersistedItem; sourceHash: string }
    | { kind: 'model'; item: PersistedItem; sourceHash: string };

/** Loads an item with its brief row; `null` when the item is missing or owned by someone else. */
export async function loadBriefTarget(userId: string, itemId: string): Promise<BriefTarget | null> {
    const item = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!item) {
        return null;
    }
    return { item, brief: await loadBrief(userId, itemId) };
}

/**
 * Pure planning step over an already-loaded target (the inline hook reuses its own read).
 *
 * The status gate comes FIRST, before `force` and before the pinned check: a `done` / `trash` item
 * is out of scope for generation entirely, and no caller — not even an explicit "Regenerate" —
 * should be able to spend a model call on one. An authored brief on a closed item is still
 * returned by the read paths; it just cannot be regenerated until the item is revived.
 */
export function planFromTarget(target: BriefTarget | null, force: boolean): BriefPlan {
    if (!target) {
        return { kind: 'not_found' };
    }
    if (!isBriefableStatus(target.item.status)) {
        return { kind: 'not_briefable', item: target.item };
    }
    if (target.brief && isPinnedOrigin(target.brief.origin) && !force) {
        return { kind: 'pinned', brief: target.brief };
    }
    const sourceHash = briefSourceHash(target.item.title, target.item.notes);
    return { kind: shouldSkipBrief(target.item.notes) ? 'skip' : 'model', item: target.item, sourceHash };
}

export async function planBriefGeneration({ userId, itemId, force }: Omit<GenerateBriefParams, 'deviceId'>): Promise<BriefPlan> {
    return planFromTarget(await loadBriefTarget(userId, itemId), force);
}

function asSkipped(written: BriefWriteOutcome): GenerateBriefResult {
    // A skip write that found the row already current is still "skipped" to the caller: the
    // recorded decision stands. Pinned and stale outcomes pass through unchanged.
    if (written.outcome === 'written' || written.outcome === 'unchanged') {
        return { outcome: 'skipped', brief: written.brief };
    }
    return written;
}

/**
 * Carries out a plan: skip rule → skipped row (no model call); model → one call then a
 * compare-and-set write. Model errors propagate (`briefErrorToHttp` maps them at the route); the
 * write never throws for stale/pinned races, it reports them as outcomes. A `pinned` outcome
 * AFTER a model plan means an authored brief landed mid-flight — the model call was still spent.
 */
export async function executeBriefPlan(plan: BriefPlan, { userId, itemId, deviceId, force }: GenerateBriefParams): Promise<GenerateBriefResult> {
    if (plan.kind === 'not_found') {
        return { outcome: 'not_found', brief: null };
    }
    if (plan.kind === 'not_briefable') {
        return { outcome: 'not_briefable', brief: null };
    }
    if (plan.kind === 'pinned') {
        return { outcome: 'pinned', brief: plan.brief };
    }
    const { sourceHash } = plan;
    if (plan.kind === 'skip') {
        return asSkipped(await writeSkippedBrief({ userId, itemId, sourceHash, deviceId, force }));
    }
    const generated = await generateBriefText(plan.item);
    const written = await writeModelBrief({ userId, itemId, sourceHash, generated, deviceId, force });
    // The model writer never reports `unchanged` (it always writes when allowed); narrow for the contract.
    return written.outcome === 'unchanged' ? { outcome: 'written', brief: written.brief } : written;
}

/** One generation for one item, end to end (plan + execute). */
export async function generateBriefForItem(params: GenerateBriefParams): Promise<GenerateBriefResult> {
    return executeBriefPlan(await planBriefGeneration(params), params);
}
