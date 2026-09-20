/** Write-path escape hatch (lib/brief/briefInlineHook.ts): debounce, flag gate, provenance skips,
 * per-user cap, serial drain, failure isolation. The service is mocked so no Mongo or model is
 * involved; timers are fake. Wiring into the apply pipeline is covered by briefInlineIntegration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    __pendingInlineBriefCountForTests,
    __resetInlineBriefTimersForTests,
    INLINE_BRIEF_DEBOUNCE_MS,
    isServerOriginatedDevice,
    maybeScheduleInlineBriefs,
    scheduleInlineBrief,
} from '../lib/brief/briefInlineHook.js';
import type { OperationInterface } from '../types/entities.js';

const loadBriefTarget = vi.fn();
const planFromTarget = vi.fn();
const executeBriefPlan = vi.fn();
vi.mock('../lib/brief/briefService.js', () => ({
    loadBriefTarget: (...args: unknown[]) => loadBriefTarget(...args),
    planFromTarget: (...args: unknown[]) => planFromTarget(...args),
    executeBriefPlan: (...args: unknown[]) => executeBriefPlan(...args),
}));

const isBriefTarget = vi.fn();
vi.mock('../lib/brief/briefTargets.js', () => ({ isBriefTarget: (...args: unknown[]) => isBriefTarget(...args) }));

const chargeBriefGeneration = vi.fn();
vi.mock('../lib/brief/briefCap.js', () => ({ chargeBriefGeneration: (...args: unknown[]) => chargeBriefGeneration(...args) }));

const MODEL_PLAN = { kind: 'model', item: { title: 't', notes: 'n' }, sourceHash: 'h' };

function itemOp(entityId: string, opType: OperationInterface['opType'] = 'update', extra: Partial<OperationInterface> = {}): OperationInterface {
    return { _id: `op-${entityId}-${opType}`, user: 'u1', deviceId: 'dev-1', ts: 't', entityType: 'item', entityId, opType, snapshot: null, ...extra };
}

/** Lets the timer callbacks' awaited (mocked) promises settle. */
async function fireDebounce(): Promise<void> {
    await vi.advanceTimersByTimeAsync(INLINE_BRIEF_DEBOUNCE_MS);
    await vi.waitFor(() => expect(__pendingInlineBriefCountForTests()).toBe(0));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('BRIEF_INLINE_ON_WRITE', '1');
    loadBriefTarget.mockReset().mockResolvedValue({ item: { title: 't', notes: 'n' }, brief: null });
    isBriefTarget.mockReset().mockReturnValue(true);
    planFromTarget.mockReset().mockReturnValue(MODEL_PLAN);
    chargeBriefGeneration.mockReset().mockReturnValue(null);
    executeBriefPlan.mockReset().mockResolvedValue({ outcome: 'written', brief: null });
});

afterEach(() => {
    __resetInlineBriefTimersForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('scheduleInlineBrief', () => {
    it('coalesces N writes within the window into one generation, stamped server:brief-inline and never forced', async () => {
        for (let i = 0; i < 5; i++) {
            scheduleInlineBrief('u1', 'item-1');
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(executeBriefPlan).not.toHaveBeenCalled();
        await fireDebounce();
        expect(executeBriefPlan).toHaveBeenCalledTimes(1);
        expect(planFromTarget).toHaveBeenCalledWith({ item: { title: 't', notes: 'n' }, brief: null }, false);
        expect(executeBriefPlan).toHaveBeenCalledWith(MODEL_PLAN, { userId: 'u1', itemId: 'item-1', deviceId: 'server:brief-inline', force: false });
    });

    it('keeps separate timers per (user, item)', async () => {
        scheduleInlineBrief('u1', 'a');
        scheduleInlineBrief('u1', 'b');
        scheduleInlineBrief('u2', 'a');
        expect(__pendingInlineBriefCountForTests()).toBe(3);
        await fireDebounce();
        expect(executeBriefPlan).toHaveBeenCalledTimes(3);
        expect(loadBriefTarget).toHaveBeenCalledWith('u2', 'a');
    });

    it('runs fired generations one at a time (a flushed batch never fans out in parallel)', async () => {
        // Track overlap: the mocked execute resolves only after a real-clock tick, so parallel
        // runs would be observable as inFlight > 1.
        const overlap: number[] = [];
        // A counter is the only way to observe concurrency from inside the mock; scoped to this test.
        let inFlight = 0;
        executeBriefPlan.mockImplementation(async () => {
            inFlight += 1;
            overlap.push(inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight -= 1;
            return { outcome: 'written', brief: null };
        });
        for (const id of ['a', 'b', 'c', 'd']) {
            scheduleInlineBrief('u1', id);
        }
        await fireDebounce();
        await vi.waitFor(() => expect(executeBriefPlan).toHaveBeenCalledTimes(4));
        expect(Math.max(...overlap)).toBe(1);
    });

    it('re-checks the target rule when the timer fires and skips items that no longer need a brief', async () => {
        isBriefTarget.mockReturnValue(false);
        scheduleInlineBrief('u1', 'item-1');
        await fireDebounce();
        expect(loadBriefTarget).toHaveBeenCalledWith('u1', 'item-1');
        expect(executeBriefPlan).not.toHaveBeenCalled();
        expect(chargeBriefGeneration).not.toHaveBeenCalled();
    });

    it('skips an item that was deleted before the timer fired', async () => {
        loadBriefTarget.mockResolvedValue(null);
        scheduleInlineBrief('u1', 'gone');
        await fireDebounce();
        expect(executeBriefPlan).not.toHaveBeenCalled();
    });

    it('charges the per-user cap for model plans and stops (with a warning) when it is exhausted', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        chargeBriefGeneration.mockReturnValueOnce(null).mockReturnValueOnce(120);
        scheduleInlineBrief('u1', 'a');
        scheduleInlineBrief('u1', 'b');
        await fireDebounce();
        await vi.waitFor(() => expect(chargeBriefGeneration).toHaveBeenCalledTimes(2));
        expect(chargeBriefGeneration).toHaveBeenCalledWith('u1');
        expect(executeBriefPlan).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[brief-inline\] .*cap reached/));
    });

    it('does not charge the cap for a skip plan', async () => {
        planFromTarget.mockReturnValue({ kind: 'skip', item: {}, sourceHash: 'h' });
        scheduleInlineBrief('u1', 'short');
        await fireDebounce();
        expect(chargeBriefGeneration).not.toHaveBeenCalled();
        expect(executeBriefPlan).toHaveBeenCalledTimes(1);
    });

    it('swallows a generation failure and logs it under the [brief-inline] prefix', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        executeBriefPlan.mockRejectedValue(new Error('model down'));
        scheduleInlineBrief('u1', 'item-1');
        await fireDebounce();
        await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[brief-inline\] .*model down/)));
    });
});

describe('maybeScheduleInlineBriefs', () => {
    it('does nothing when the flag is off', () => {
        vi.stubEnv('BRIEF_INLINE_ON_WRITE', '');
        maybeScheduleInlineBriefs([itemOp('item-1')], 'dev-1');
        expect(__pendingInlineBriefCountForTests()).toBe(0);
    });

    it('schedules item create/update ops from a device or the public API only', () => {
        maybeScheduleInlineBriefs(
            [
                itemOp('created', 'create'),
                itemOp('updated', 'update'),
                itemOp('deleted', 'delete'),
                { ...itemOp('routine-1'), entityType: 'routine' },
                { ...itemOp('brief-1'), entityType: 'itemBrief' },
                itemOp('quarantined', 'update', { notApplied: true }),
            ],
            'api:token-1',
        );
        expect(__pendingInlineBriefCountForTests()).toBe(2);
    });

    it('skips server-originated writes: bare "server" (GCal inbound / routine generator) and any server:* stamp', () => {
        maybeScheduleInlineBriefs([itemOp('item-1')], 'server');
        maybeScheduleInlineBriefs([itemOp('item-2')], 'server:brief-inline');
        maybeScheduleInlineBriefs([itemOp('item-3')], 'server:brief-cascade');
        expect(__pendingInlineBriefCountForTests()).toBe(0);
        expect(isServerOriginatedDevice('server')).toBe(true);
        expect(isServerOriginatedDevice('server:x')).toBe(true);
        expect(isServerOriginatedDevice('serverless-device')).toBe(false);
        expect(isServerOriginatedDevice('api:t')).toBe(false);
    });
});
