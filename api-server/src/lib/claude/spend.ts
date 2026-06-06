import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import claudeUsageDAO from '../../dataAccess/claudeUsageDAO.js';
import type { AssistUsage } from './agentLoop.js';

dayjs.extend(utc);

/**
 * Per-user daily spend cap + COGS metering for Lane A. The cap is checked BEFORE the model call (so
 * an over-budget user is rejected without spending anything) and usage is recorded AFTER (so spend
 * is captured even on a partial or failed loop). One row per (user, day), keyed `${user}:${day}`.
 */

// Sonnet 4.6 published rates (USD per 1M tokens). Kept here, tied to CLAUDE_ASSIST_MODEL.
const RATE_INPUT_PER_M = 3;
const RATE_OUTPUT_PER_M = 15;
const RATE_CACHE_READ_PER_M = 0.3; // ~0.1× input
const RATE_CACHE_WRITE_PER_M = 3.75; // 1.25× input (5-min TTL)

const DEFAULT_DAILY_COST_CAP_USD = 1.0;

function dailyCapUsd(): number {
    const raw = process.env.CLAUDE_ASSIST_DAILY_COST_CAP_USD;
    const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_COST_CAP_USD;
}

function utcDay(): string {
    // UTC (not server-local) so the daily window and the `${user}:${day}` key are host-independent.
    return dayjs.utc().format('YYYY-MM-DD');
}

/** Estimated USD cost of one call's token usage at the model's published rates. */
export function estimateCostUsd(usage: AssistUsage): number {
    return (
        (usage.inputTokens * RATE_INPUT_PER_M +
            usage.outputTokens * RATE_OUTPUT_PER_M +
            usage.cacheReadTokens * RATE_CACHE_READ_PER_M +
            usage.cacheCreationTokens * RATE_CACHE_WRITE_PER_M) /
        1_000_000
    );
}

/** True if the user is already at/over their daily cap — checked before the model call. */
export async function isOverDailyCap(userId: string): Promise<boolean> {
    const row = await claudeUsageDAO.findOne({ _id: `${userId}:${utcDay()}` });
    return (row?.estimatedCostUsd ?? 0) >= dailyCapUsd();
}

/** Records one call's usage as an atomic per-(user, day) increment. Safe to call on partial/failed loops. */
export async function recordUsage(userId: string, usage: AssistUsage): Promise<void> {
    const day = utcDay();
    await claudeUsageDAO.updateOne(
        { _id: `${userId}:${day}` },
        {
            $inc: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                estimatedCostUsd: estimateCostUsd(usage),
                callCount: 1,
            },
            $set: { updatedTs: dayjs().toISOString() },
            $setOnInsert: { _id: `${userId}:${day}`, user: userId, day },
        },
        { upsert: true },
    );
}
