import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { db } from '../loaders/mainLoader.js';

// 2 s rather than 1 s: an Atlas M0 under transfer throttling can stretch a single round trip, and a
// probe that flaps on that would page for nothing. Still inside the startup probe's timeoutSeconds=3
// (deploy-api.yml), so the 503 — and its log line — land before Cloud Run gives up on the attempt.
const PING_TIMEOUT_MS = 2000;

export type HealthProbe = () => Promise<void>;

/**
 * Builds a probe that round-trips a `ping` on the Db the getter returns. `timeoutMS` (driver CSOT)
 * bounds server selection AND the round trip — but only on a client that has already run
 * `connect()`: the driver's implicit first connect ignores per-operation timeouts and waits the full
 * `serverSelectionTimeoutMS` (30 s). `index.ts` awaits `loadDataAccess()` before `serve()`, so the
 * live probe always runs against a connected client and a dead pool answers in ~`timeoutMs`.
 */
export function createPingProbe(getDb: () => Db, timeoutMs = PING_TIMEOUT_MS): HealthProbe {
    return async () => {
        await getDb().command({ ping: 1 }, { timeoutMS: timeoutMs });
    };
}

export const pingDatabase = createPingProbe(() => db);

/**
 * `GET /health` — the Cloud Run startup probe target (deploy-api.yml) and the endpoint an uptime
 * check should hit. `/version` answers 200 as soon as the process is up, which says nothing about
 * whether the instance can serve; this one fails when the database does. The probe is injectable so
 * the failure path is testable without tearing down the shared connection.
 */
export function createHealthRoutes(probe: HealthProbe = pingDatabase) {
    return new Hono().get('/', async (c) => {
        try {
            await probe();
            return c.json({ status: 'ok' });
        } catch (error) {
            console.error('[health] database probe failed', error);
            return c.json({ status: 'unavailable' }, 503);
        }
    });
}
