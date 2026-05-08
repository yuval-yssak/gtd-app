import dayjs from 'dayjs';
import type { Context, MiddlewareHandler } from 'hono';
import type { BearerVariables } from '../auth/bearerMiddleware.js';

/**
 * Structured per-request logger for /v1/*. Emits one JSON line to stdout per request, captured
 * by Cloud Logging in production. Build dashboards on top of these lines:
 *   - Requests/min by route (filter scope="v1", group by route)
 *   - 4xx / 5xx rate (status >= 400)
 *   - p50 / p95 / p99 latency from durationMs
 *   - Replay rate (replayed=true / total) — high values mean a caller has a retry bug
 *   - Per-token request count (group by tokenId)
 *
 * "Minimum useful version" per issue #19 step 10 — no OpenTelemetry exporter, no Prometheus
 * endpoint. Just structured stdout, which Cloud Run promotes to structured logs automatically.
 */

interface V1LogLine {
    level: 'info';
    scope: 'v1';
    route: string;
    method: string;
    status: number;
    durationMs: number;
    replayed: boolean;
    ts: string;
    /** Populated when the request was authenticated. Absent on 401/429 anonymous-bucket rejections. */
    userId?: string;
    tokenId?: string;
}

function buildLogLine(c: Context, durationMs: number): V1LogLine {
    const replayedHeader = c.res.headers.get('x-idempotent-replay');
    const apiAuth = (c.var as Partial<BearerVariables>).apiAuth;
    const line: V1LogLine = {
        level: 'info',
        scope: 'v1',
        route: c.req.path,
        method: c.req.method,
        status: c.res.status,
        durationMs,
        replayed: replayedHeader === 'true',
        ts: dayjs().toISOString(),
    };
    if (apiAuth) {
        line.userId = apiAuth.userId;
        line.tokenId = apiAuth.tokenId;
    }
    return line;
}

/** Mounted at the top of every /v1/* router so durations include all
 * downstream middleware (auth, rate-limit, scope check). */
export function v1RequestLogger(): MiddlewareHandler {
    return async (c, next) => {
        const start = Date.now();
        await next();
        const durationMs = Date.now() - start;
        // Stringify ourselves so the line is exactly one record on stdout — Cloud Logging parses
        // JSON automatically when the line is valid JSON.
        console.log(JSON.stringify(buildLogLine(c, durationMs)));
    };
}
