import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import claudeAsksDAO from '../dataAccess/claudeAsksDAO.js';
import type { ClaudeAskInterface, ClaudeAskOutcome } from '../types/entities.js';
import { applyAndPublishOperation, applyAndPublishOperationWithOutcome } from './applyOperation.js';
import { KeyedMutex } from './keyedMutex.js';

const DEVICE_ID = 'server:claude-ask';

/**
 * How long after starting a Claude routine on an item another start is refused. `/fire` has no
 * idempotency key, so this is the only guard against a double click — or a retry after a timeout
 * whose session was in fact created — opening two sessions.
 */
export const CLAUDE_ASK_IN_FLIGHT_SECONDS = 20;

/** One start per item at a time: the in-flight read, the start and the row write happen under this lock. */
const startMutex = new KeyedMutex();

export function withClaudeAskStartLock<T>(itemId: string, task: () => Promise<T>): Promise<T> {
    return startMutex.withLock(itemId, task);
}

/**
 * Starts that left no `claudeAsks` row: a timeout, a network failure or a 5xx may still have
 * created the session upstream, so the attempt itself must hold the in-flight window. In memory
 * is enough: the API runs as a single Cloud Run instance (`--max-instances=1`), and a cold start
 * that loses the map is far rarer than the double click it guards against.
 */
const unrecordedStarts = new Map<string, string>();

function startKey(userId: string, itemId: string): string {
    return `${userId}:${itemId}`;
}

export function markClaudeAskStarting(userId: string, itemId: string, now: string): void {
    pruneExpiredStarts(now);
    unrecordedStarts.set(startKey(userId, itemId), now);
}

/** A timed-out start that is never retried would otherwise stay in the map until the next cold start. */
function pruneExpiredStarts(now: string): void {
    const expired = [...unrecordedStarts].filter(([, ts]) => dayjs(now).diff(ts, 'second', true) >= CLAUDE_ASK_IN_FLIGHT_SECONDS).map(([key]) => key);
    for (const key of expired) {
        unrecordedStarts.delete(key);
    }
}

/** A definite refusal (bad token, missing or paused Claude routine, rate limit) started nothing. */
export function clearClaudeAskStarting(userId: string, itemId: string): void {
    unrecordedStarts.delete(startKey(userId, itemId));
}

/**
 * Seconds until another start on the item is allowed — 0 when none is in flight. Counts both the
 * latest recorded ask and an unrecorded attempt.
 */
export async function claudeAskInFlightSecondsLeft(userId: string, itemId: string, now: string): Promise<number> {
    const [latest] = await claudeAsksDAO.findArray({ user: userId, itemId }, { sort: { createdTs: -1 }, limit: 1 });
    const startedTimes = [latest?.createdTs, unrecordedStarts.get(startKey(userId, itemId))].filter((ts): ts is string => ts !== undefined);
    const left = Math.max(0, ...startedTimes.map((ts) => CLAUDE_ASK_IN_FLIGHT_SECONDS - dayjs(now).diff(ts, 'second', true)));
    if (left === 0) {
        clearClaudeAskStarting(userId, itemId);
    }
    return Math.ceil(left);
}

export function newClaudeAskId(): string {
    return randomUUID();
}

export interface StartedClaudeAsk {
    askId: string;
    userId: string;
    itemId: string;
    prompt: string;
    sessionId: string;
    sessionUrl: string;
    now: string;
}

/** Records a started session as a new `claudeAsk` row through the shared op pipeline. */
export async function recordClaudeAsk(started: StartedClaudeAsk): Promise<ClaudeAskInterface> {
    const snapshot: ClaudeAskInterface = {
        _id: started.askId,
        user: started.userId,
        itemId: started.itemId,
        prompt: started.prompt,
        sessionId: started.sessionId,
        sessionUrl: started.sessionUrl,
        createdTs: started.now,
        updatedTs: started.now,
    };
    await applyAndPublishOperation(
        started.userId,
        { entityType: 'claudeAsk', entityId: started.askId, opType: 'create', snapshot },
        { deviceId: DEVICE_ID, now: started.now, strict: true },
    );
    return snapshot;
}

export interface ClaudeAskReport {
    summary: string;
    outcome: ClaudeAskOutcome;
}

/**
 * Writes Claude's report onto an ask. A repeated report overwrites the previous one, so the tool
 * stays idempotent and a session that first said "needs input" can later report completion.
 * Returns null when the ask is not the caller's — or was deleted (its item went away) between the
 * read and the write, which the pipeline reports as `skipped_missing`.
 */
export async function reportClaudeAskResult(userId: string, askId: string, report: ClaudeAskReport, deviceId: string): Promise<ClaudeAskInterface | null> {
    const existing = await claudeAsksDAO.findByOwnerAndId(askId, userId);
    if (!existing) {
        return null;
    }
    const now = dayjs().toISOString();
    const snapshot: ClaudeAskInterface = { ...existing, result: { ...report, reportedTs: now }, updatedTs: now };
    const { outcome } = await applyAndPublishOperationWithOutcome(
        userId,
        { entityType: 'claudeAsk', entityId: askId, opType: 'update', snapshot },
        { deviceId, now, strict: true },
    );
    return outcome === 'applied' ? snapshot : null;
}
