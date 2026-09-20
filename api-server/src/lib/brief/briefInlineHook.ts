import type { OperationInterface } from '../../types/entities.js';
import { KeyedMutex } from '../keyedMutex.js';

/**
 * Write-path escape hatch (`BRIEF_INLINE_ON_WRITE=1`, off by default): regenerate an item's
 * brief shortly after it is edited, instead of waiting for the Phase 3 sweep. Trailing debounce
 * per item so an autosave burst costs one model call, fire-and-forget so the write response is
 * never delayed or altered by generation. Generations run ONE AT A TIME (a `/sync/push` flush of
 * N items arms N timers that all fire together) and each charges the same per-user cap as the
 * on-demand endpoint, so flipping the flag can never fan out into an Anthropic 429 storm.
 * Correct under Cloud Run `--max-instances=1`: one process owns the timer map.
 */

export const INLINE_BRIEF_DEBOUNCE_MS = 30_000;
const DEVICE_ID = 'server:brief-inline';
const LOG_PREFIX = '[brief-inline]';
const DRAIN_KEY = 'inline-brief-drain';

const pendingTimers = new Map<string, NodeJS.Timeout>();
/** Single-key mutex = a FIFO queue with concurrency 1 for every fired timer. */
const drain = new KeyedMutex();

export function isInlineBriefEnabled(): boolean {
    return process.env.BRIEF_INLINE_ON_WRITE === '1';
}

/**
 * Server-originated writes never trigger inline generation: `server` is the stamp of GCal-inbound
 * and routine-generator writes (`recordOperation`'s default) — the perpetual-noop calendar churn
 * must never turn into model calls — and `server:*` marks brief/cascade writes themselves.
 */
export function isServerOriginatedDevice(deviceId: string): boolean {
    return deviceId === 'server' || deviceId.startsWith('server:');
}

async function runInlineBrief(userId: string, itemId: string): Promise<void> {
    // Lazy imports keep this hook free of a static cycle: applyOperation → hook → service →
    // writer → itemBriefs → applyOperation.
    const [service, { isBriefTarget }, { chargeBriefGeneration }] = await Promise.all([
        import('./briefService.js'),
        import('./briefTargets.js'),
        import('./briefCap.js'),
    ]);
    const target = await service.loadBriefTarget(userId, itemId);
    // `isBriefTarget` is load-bearing here (unlike the on-demand path): a fresh model brief must
    // not be regenerated just because the item was touched again.
    if (!target || !isBriefTarget(target.item, target.brief)) {
        return;
    }
    const plan = service.planFromTarget(target, false);
    if (plan.kind === 'model' && chargeBriefGeneration(userId) !== null) {
        console.warn(`${LOG_PREFIX} item=${itemId} skipped: per-user generation cap reached`);
        return;
    }
    const result = await service.executeBriefPlan(plan, { userId, itemId, deviceId: DEVICE_ID, force: false });
    console.info(`${LOG_PREFIX} item=${itemId} outcome=${result.outcome}`);
}

function fireInlineBrief(userId: string, itemId: string): Promise<void> {
    return drain
        .withLock(DRAIN_KEY, () => runInlineBrief(userId, itemId))
        .catch((err: unknown) => {
            console.error(`${LOG_PREFIX} generation failed for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
        });
}

/** (Re)arms the per-item trailing timer; the last write within the window wins. */
export function scheduleInlineBrief(userId: string, itemId: string): void {
    const key = `${userId}:${itemId}`;
    const pending = pendingTimers.get(key);
    if (pending) {
        clearTimeout(pending);
    }
    const timer = setTimeout(() => {
        pendingTimers.delete(key);
        void fireInlineBrief(userId, itemId);
    }, INLINE_BRIEF_DEBOUNCE_MS);
    // Never keep the process alive for a pending brief (tests, graceful shutdown).
    timer.unref();
    pendingTimers.set(key, timer);
}

/**
 * Post-write hook called by the apply pipeline with the ops it just persisted. Only successful
 * item create/update ops from a real device (or the public API) schedule generation.
 */
export function maybeScheduleInlineBriefs(ops: OperationInterface[], deviceId: string): void {
    if (!isInlineBriefEnabled() || isServerOriginatedDevice(deviceId)) {
        return;
    }
    for (const op of ops) {
        if (op.entityType === 'item' && (op.opType === 'create' || op.opType === 'update') && !op.notApplied) {
            scheduleInlineBrief(op.user, op.entityId);
        }
    }
}

/** Test-only: cancel every pending timer so fake-timer specs do not leak into each other. */
export function __resetInlineBriefTimersForTests(): void {
    for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
    }
    pendingTimers.clear();
}

/** Test-only: number of items with a pending inline generation. */
export function __pendingInlineBriefCountForTests(): number {
    return pendingTimers.size;
}

/** Test-only: fire every pending timer now (no fake clock needed) and wait for the generations to settle. */
export async function __flushInlineBriefTimersForTests(): Promise<void> {
    const keys = [...pendingTimers.keys()];
    __resetInlineBriefTimersForTests();
    await Promise.all(
        keys.map((key) => {
            const [userId = '', ...rest] = key.split(':');
            return fireInlineBrief(userId, rest.join(':'));
        }),
    );
}
