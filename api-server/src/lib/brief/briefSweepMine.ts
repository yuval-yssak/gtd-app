import dayjs from 'dayjs';
import { withBriefGenerationDrain } from './briefDrain.js';
import { executePlan, executePlansSerially, type ModelPlan, type PartitionedPlans, partitionPlans } from './briefPlans.js';
import { findUserBriefTargets } from './briefTargets.js';

/**
 * Review-start sweep (docs/plans/item-brief.md, open decision 5): when the Weekly Review opens,
 * the caller's LIVE items whose title + notes checksum no longer matches their brief (or that
 * have none) get fresh briefs — skip rows synchronously (cheap DB writes, unbounded), then at
 * most `BRIEF_REVIEW_SWEEP_MAX` model generations in the background, strictly one at a time
 * through the shared drain. Pinned briefs are never touched. Independent of the on-demand cap
 * (`briefCap.ts`): the bound here is the per-user cooldown plus the 50-call ceiling.
 */

export const BRIEF_REVIEW_SWEEP_MAX = 50;
/**
 * Ceiling on the targets ONE review-start sweep selects. The skip leg runs synchronously before
 * the response, so an unbounded backlog would sit in front of the user opening their review — and
 * the backlog is genuinely large exactly once, on the first review after the boot backfill marks a
 * whole pre-existing corpus. The cron sweep drains the rest at its own cadence; this route only
 * has to make the review the user is opening right now look right.
 */
export const BRIEF_REVIEW_SWEEP_SELECTION_MAX = 500;
export const BRIEF_REVIEW_SWEEP_DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEVICE_ID = 'server:brief-sweep-mine';
const LOG_PREFIX = '[brief-sweep-mine]';

export type ReviewBriefSweepResult = { started: 0; cooldown: true } | { started: number; skippedWritten: number; cooldown: false };

/**
 * userId → epoch ms of the last sweep start. In-process only: one Cloud Run instance owns it, but
 * it is erased by every cold start and deploy, so the bound is best-effort — a user who reloads
 * the review after an idle period can trigger one more sweep. The 50-call ceiling per sweep is
 * the hard bound; the batch pipeline's in-flight guard is DB-backed and unaffected.
 */
const lastStartedAtMs = new Map<string, number>();
/** Background runs still in flight — awaited by tests, never by callers. */
const inFlight = new Set<Promise<void>>();

/**
 * Read per call so an operator override (and a test stub) takes effect without a restart. Only an
 * explicit non-negative integer overrides the default: `Number('')` is 0, so an EMPTY env var —
 * what `deploy-api.yml` writes for an unset GitHub variable — must not silently disable the only
 * limiter on this route. `'0'` is the deliberate way to disable it.
 */
export function reviewSweepCooldownMs(): number {
    const raw = process.env.BRIEF_REVIEW_SWEEP_COOLDOWN_MS?.trim();
    if (!raw) {
        return BRIEF_REVIEW_SWEEP_DEFAULT_COOLDOWN_MS;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : BRIEF_REVIEW_SWEEP_DEFAULT_COOLDOWN_MS;
}

function isInCooldown(userId: string, nowMs: number): boolean {
    const last = lastStartedAtMs.get(userId);
    return last !== undefined && nowMs - last < reviewSweepCooldownMs();
}

/**
 * Plans the caller's outstanding targets, so even the stale short-note items get their skip row.
 * Shares `findUserBriefTargets` with the cron sweep — deliberately ONE selection implementation —
 * so it inherits the `briefStale` index bound: what used to be a walk of the user's whole item set
 * is now a lookup over just the items marked since their last brief, in the open statuses only.
 *
 * Bounded by `BRIEF_REVIEW_SWEEP_SELECTION_MAX` rather than unbounded: in the steady state the
 * marked set is a handful of items and the cap never binds, but right after the boot backfill it
 * is the user's entire corpus — and the skip leg below writes synchronously before responding.
 */
async function planUserTargets(userId: string): Promise<PartitionedPlans> {
    return partitionPlans(await findUserBriefTargets(userId, BRIEF_REVIEW_SWEEP_SELECTION_MAX));
}

/** One model plan through the drain; a failure is logged and the next plan still runs. */
async function generateOne(userId: string, plan: ModelPlan): Promise<void> {
    try {
        const { outcome } = await withBriefGenerationDrain(() => executePlan(plan, DEVICE_ID));
        console.info(`${LOG_PREFIX} user=${userId} item=${plan.item._id} outcome=${outcome}`);
    } catch (err) {
        console.error(`${LOG_PREFIX} user=${userId} item=${plan.item._id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function generateSerially(userId: string, models: ModelPlan[]): Promise<void> {
    for (const plan of models) {
        await generateOne(userId, plan);
    }
}

function fireInBackground(userId: string, models: ModelPlan[]): void {
    const run = generateSerially(userId, models).finally(() => inFlight.delete(run));
    inFlight.add(run);
}

/**
 * Starts the caller's sweep and returns as soon as the skip rows are written; model generations
 * continue in the background. The cooldown is stamped BEFORE any work so a double-fire (two tabs
 * opening the review together) collapses to one sweep.
 */
export async function startReviewBriefSweep(userId: string): Promise<ReviewBriefSweepResult> {
    const nowMs = dayjs().valueOf();
    if (isInCooldown(userId, nowMs)) {
        return { started: 0, cooldown: true };
    }
    lastStartedAtMs.set(userId, nowMs);
    const { skips, models } = await planUserTargets(userId);
    const skippedWritten = await executePlansSerially(skips, DEVICE_ID);
    const bounded = models.slice(0, BRIEF_REVIEW_SWEEP_MAX);
    if (bounded.length > 0) {
        fireInBackground(userId, bounded);
    }
    return { started: bounded.length, skippedWritten, cooldown: false };
}

/** Test-only: forget every cooldown stamp. */
export function __resetReviewSweepCooldownForTests(): void {
    lastStartedAtMs.clear();
}

/** Test-only: wait for every background generation run started so far. */
export async function __settleReviewSweepsForTests(): Promise<void> {
    await Promise.all([...inFlight]);
}
