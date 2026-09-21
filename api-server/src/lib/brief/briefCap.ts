import dayjs from 'dayjs';
import { type BucketConfig, defaultStore, tryConsume } from '../../auth/rateLimitMiddleware.js';

/**
 * Per-USER generation cap shared by every path that reaches the model (on-demand endpoint,
 * inline hook): 30 per 10 minutes by default, `BRIEF_GENERATE_PER_10MIN` to tune. Keyed by
 * userId, not token, so a user cannot multiply the budget by minting tokens. Charged only when a
 * model call is about to happen — skip-rule, pinned and not-found outcomes are free.
 */

const WINDOW_SEC = 10 * 60;
const DEFAULT_PER_WINDOW = 30;

/** Read per call (not at module load) so an operator override — and a test stub — takes effect. */
export function generationBucket(): BucketConfig {
    const raw = Number(process.env.BRIEF_GENERATE_PER_10MIN);
    const capacity = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PER_WINDOW;
    return { capacity, refillPerSec: capacity / WINDOW_SEC };
}

/** Charges one generation; `null` when allowed, otherwise the seconds until the next one is. */
export function chargeBriefGeneration(userId: string): number | null {
    const result = tryConsume(defaultStore, `brief-generate:${userId}`, generationBucket(), dayjs().valueOf());
    return result.allowed ? null : result.retryAfterSec;
}
