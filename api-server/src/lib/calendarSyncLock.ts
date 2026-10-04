import dayjs from 'dayjs';
import type { CalendarSyncConfigInterface } from '../types/entities.js';
import { KeyedMutex } from './keyedMutex.js';

/**
 * Per-calendar serialization of inbound syncs. Lifted out of routes/calendar.ts so lib code (account
 * deletion) can wait for in-flight syncs without importing the whole router. In-process only — Cloud
 * Run runs one instance, and the admin CLI (its own process) therefore cannot see the server's locks.
 *
 * Keyed by `webhookChannelId` when present, else `${user}:${calendarId}`, so configs without a live
 * channel still serialize (the unique indexes make duplicates impossible, but serializing avoids the
 * wasted insert→E11000→merge churn on every race).
 */
const syncMutex = new KeyedMutex();

/** A stable per-calendar key for the sync mutex. */
function syncKeyFor(config: CalendarSyncConfigInterface): string {
    return config.webhookChannelId ?? `${config.user}:${config.calendarId}`;
}

/**
 * Runs `task` after any in-flight sync for the same calendar completes, chaining so concurrent callers
 * serialize. `task` receives the sync's clock stamp (`now` for its SyncContext), taken the moment the
 * lock is acquired: stamping at request/webhook arrival let a sync queued behind a backlog write
 * createdTs/updatedTs/op timestamps from long before it actually ran (observed ~85 min stale on staging
 * under a client-driven sync storm), skewing LWW against every device. Structural here so every caller
 * gets it right without per-site discipline.
 */
export function withSyncLock<T>(config: CalendarSyncConfigInterface, task: (startedAt: string) => Promise<T>): Promise<T> {
    return syncMutex.withLock(syncKeyFor(config), () => task(dayjs().toISOString()));
}

/**
 * Resolves once no sync is in flight for any of `configs`. Account deletion waits on this (bounded)
 * before erasing rows: a client-driven `POST /calendar/integrations/:id/sync` that authenticated
 * moments before the deletion can run for seconds and would otherwise insert items and ops into the gap.
 */
export function drainCalendarSyncLocks(configs: CalendarSyncConfigInterface[]): Promise<void> {
    return Promise.all(configs.map((config) => withSyncLock(config, async () => undefined))).then(() => undefined);
}
