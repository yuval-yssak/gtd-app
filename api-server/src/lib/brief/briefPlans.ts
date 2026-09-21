import { type BriefPlan, executeBriefPlan, planFromTarget } from './briefService.js';
import type { BriefTarget } from './briefTargets.js';

/**
 * Plan-level helpers shared by the two sweeps (Message Batches + review-start): both turn a
 * list of selected targets into "settle the skip rule now" vs "needs a model call", and both
 * run plans one at a time. Kept here so the two cannot drift.
 */

export type SkipPlan = Extract<BriefPlan, { kind: 'skip' }>;
export type ModelPlan = Extract<BriefPlan, { kind: 'model' }>;

export interface PartitionedPlans {
    skips: SkipPlan[];
    models: ModelPlan[];
}

/** Plans every target once; pinned/not-found never occur here — the selection already excludes them. */
export function partitionPlans(targets: BriefTarget[]): PartitionedPlans {
    const plans = targets.map((target) => planFromTarget({ item: target.item, brief: target.brief ?? null }, false));
    return {
        skips: plans.filter((plan): plan is SkipPlan => plan.kind === 'skip'),
        models: plans.filter((plan): plan is ModelPlan => plan.kind === 'model'),
    };
}

export function executePlan(plan: SkipPlan | ModelPlan, deviceId: string) {
    return executeBriefPlan(plan, { userId: plan.item.user, itemId: plan.item._id, deviceId, force: false });
}

/**
 * Runs plans one at a time — each is a locked read + op write, and parallel fan-out only hurts
 * an M0 cluster — and returns how many produced a row (`skipped` for the skip rule, `written`
 * for a model brief). Stale/pinned races are outcomes, not errors, and are simply not counted.
 */
export async function executePlansSerially(plans: (SkipPlan | ModelPlan)[], deviceId: string): Promise<number> {
    // Sequential accumulation over an async loop; a reduce over promises would obscure the ordering.
    let done = 0;
    for (const plan of plans) {
        const { outcome } = await executePlan(plan, deviceId);
        if (outcome === 'skipped' || outcome === 'written') {
            done += 1;
        }
    }
    return done;
}
