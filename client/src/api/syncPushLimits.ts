/**
 * Request-shaping limits for `POST /sync/push`. Kept in their own module (like `syncAuthError.ts`) so
 * `syncClient.mock.ts` can re-export the real values without pulling the network module into the
 * test graph — `syncHelpers.ts` reads them at module load through the `#api/syncClient` alias.
 */

/**
 * Hard deadline for one push request. The push runs under the cross-context flush lock, so a request
 * that hangs (observed: a POST that never reached Cloud Run and sat until Cloudflare's 100s origin
 * timeout) would pin every other tab's and the Service Worker's flush for that long.
 *
 * Aborting is NOT free: the server may still apply the batch, and `/sync/push` has no idempotency key,
 * so the retry inserts the ops again (op-log growth, RSVP replays). The deadline therefore only needs
 * to beat the 100s hang — never to race a slow-but-progressing push (cold start, throttled Atlas, slow
 * uplink) — and batches are capped (`PUSH_BATCH_MAX`) so one request stays small. A normal push is <1s.
 */
export const PUSH_TIMEOUT_MS = 60_000;

/**
 * Max ops per `/sync/push` request. A long offline queue goes out in `queuedAt`-ordered chunks (the
 * flush loop drains until empty), keeping each request far inside `PUSH_TIMEOUT_MS` so the deadline
 * cannot abort a batch the server is about to finish applying.
 */
export const PUSH_BATCH_MAX = 50;
