import dayjs from 'dayjs';
import { Hono } from 'hono';
import { z } from 'zod';
import { authenticateRequest } from '../auth/middleware.js';
import { clientUrl } from '../config.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import {
    claudeAskInFlightSecondsLeft,
    clearClaudeAskStarting,
    markClaudeAskStarting,
    newClaudeAskId,
    recordClaudeAsk,
    withClaudeAskStartLock,
} from '../lib/claudeAsks.js';
import {
    connectionToken,
    deleteConnection,
    loadConnection,
    parseConnectionBody,
    presentConnection,
    saveConnection,
} from '../lib/claudeRoutine/claudeRoutineConnection.js';
import type { ClaudeRoutineStartFailure } from '../lib/claudeRoutine/claudeRoutineResponse.js';
import { buildClaudeRoutineText, CLAUDE_ASK_PROMPT_MAX_CHARS } from '../lib/claudeRoutine/claudeRoutineText.js';
import { startClaudeRoutine } from '../lib/claudeRoutine/startClaudeRoutine.js';
import type { AuthVariables } from '../types/authTypes.js';
import type { ClaudeAskInterface, ItemInterface } from '../types/entities.js';

/** A rejected ask — the HTTP status, a stable `code` for the client, and an optional Retry-After. */
interface AskRejection {
    status: 400 | 404 | 409 | 422 | 429 | 503;
    code: string;
    message: string;
    retryAfterSeconds?: number | null;
}

type AskOutcome = { ok: true; ask: ClaudeAskInterface } | { ok: false; rejection: AskRejection };

const AskBodySchema = z.object({
    itemId: z.string().min(1),
    prompt: z.string().trim().min(1).max(CLAUDE_ASK_PROMPT_MAX_CHARS),
});

type AskBody = z.infer<typeof AskBodySchema>;

function parseAskBody(raw: unknown): { ok: true; body: AskBody } | { ok: false; rejection: AskRejection } {
    const parsed = AskBodySchema.safeParse(raw);
    if (parsed.success) {
        return { ok: true, body: parsed.data };
    }
    const isItemIdProblem = parsed.error.issues.some((issue) => issue.path[0] === 'itemId');
    return isItemIdProblem
        ? { ok: false, rejection: { status: 400, code: 'invalid_item_id', message: 'itemId is required' } }
        : { ok: false, rejection: { status: 400, code: 'invalid_prompt', message: `prompt must be 1–${CLAUDE_ASK_PROMPT_MAX_CHARS} characters` } };
}

const START_FAILURE_MESSAGES: Record<ClaudeRoutineStartFailure['code'], string> = {
    claude_routine_token_rejected: 'Claude rejected the Claude routine token — generate a new one on claude.ai and save it in Settings',
    claude_routine_not_found: 'Claude has no Claude routine with this id — check it in Settings',
    claude_routine_unavailable: 'The Claude routine refused to start (it may be paused)',
    claude_routine_rate_limited: 'The Claude routine was started too often — try again shortly',
    claude_routine_unreachable: 'Claude could not be reached — try again shortly',
};

function startFailureRejection(failure: ClaudeRoutineStartFailure): AskRejection {
    const rejection: AskRejection = { status: failure.status, code: failure.code, message: START_FAILURE_MESSAGES[failure.code] };
    return failure.code === 'claude_routine_rate_limited' ? { ...rejection, retryAfterSeconds: failure.retryAfterSeconds } : rejection;
}

/** Only an unreachable upstream may have started a session anyway; every other failure started nothing. */
function mayHaveStarted(failure: ClaudeRoutineStartFailure): boolean {
    return failure.code === 'claude_routine_unreachable';
}

const NOT_CONNECTED: AskRejection = { status: 409, code: 'claude_routine_not_connected', message: 'Connect a Claude routine in Settings first' };
const ITEM_NOT_FOUND: AskRejection = { status: 404, code: 'not_found', message: 'item not found' };

function itemLink(itemId: string): string {
    return `${clientUrl}/item/${encodeURIComponent(itemId)}`;
}

/** Everything a validated ask needs to start: who asks, about which item, with which token. */
interface ValidatedAsk {
    userId: string;
    body: AskBody;
    item: ItemInterface;
    claudeRoutineId: string;
    token: string;
}

async function loadOpenItem(userId: string, itemId: string): Promise<ItemInterface | null> {
    const item = await itemsDAO.findByOwnerAndId(itemId, userId);
    return item && item.status !== 'trash' ? item : null;
}

/**
 * Starts the user's Claude routine for one item and records the ask. Runs under the per-item
 * start lock so the in-flight check, the start and the row write cannot interleave with a second click.
 */
async function askClaude(userId: string, body: AskBody): Promise<AskOutcome> {
    const item = await loadOpenItem(userId, body.itemId);
    if (!item) {
        return { ok: false, rejection: ITEM_NOT_FOUND };
    }
    const credentials = await loadCredentials(userId);
    if (!credentials) {
        return { ok: false, rejection: NOT_CONNECTED };
    }
    return withClaudeAskStartLock(body.itemId, () => startAndRecord({ userId, body, item, ...credentials }));
}

/** A row whose token no longer decrypts (key rotation, corruption) is as good as no connection. */
async function loadCredentials(userId: string): Promise<{ claudeRoutineId: string; token: string } | null> {
    const connection = await loadConnection(userId);
    if (!connection) {
        return null;
    }
    try {
        return { claudeRoutineId: connection.claudeRoutineId, token: connectionToken(connection) };
    } catch (err) {
        console.error('[claudeRoutine] stored token failed to decrypt', { userId, name: err instanceof Error ? err.name : 'unknown' });
        return null;
    }
}

async function startAndRecord(ask: ValidatedAsk): Promise<AskOutcome> {
    const { userId, body } = ask;
    const secondsLeft = await claudeAskInFlightSecondsLeft(userId, body.itemId, dayjs().toISOString());
    if (secondsLeft > 0) {
        const message = 'Claude was just asked about this item — wait a few seconds';
        return { ok: false, rejection: { status: 409, code: 'claude_ask_in_flight', message, retryAfterSeconds: secondsLeft } };
    }
    const askId = newClaudeAskId();
    markClaudeAskStarting(userId, body.itemId, dayjs().toISOString());
    const text = buildClaudeRoutineText({ askId, prompt: body.prompt, item: { ...ask.item, _id: body.itemId }, itemUrl: itemLink(body.itemId) });
    const started = await startClaudeRoutine({ askId, claudeRoutineId: ask.claudeRoutineId, token: ask.token, text });
    if (!started.ok) {
        return refuseStart(ask, started.failure);
    }
    return recordStartedAsk(ask, { askId, sessionId: started.sessionId, sessionUrl: started.sessionUrl });
}

function refuseStart({ userId, body }: ValidatedAsk, failure: ClaudeRoutineStartFailure): AskOutcome {
    if (!mayHaveStarted(failure)) {
        clearClaudeAskStarting(userId, body.itemId);
    }
    console.log('[claudeRoutine] start refused', { userId, itemId: body.itemId, code: failure.code });
    return { ok: false, rejection: startFailureRejection(failure) };
}

/**
 * The item may have been hard-deleted during the start round trip; an ask recorded then would
 * hang off nothing (creates are never skipped), so it is dropped. The session itself already runs.
 */
async function recordStartedAsk({ userId, body }: ValidatedAsk, session: { askId: string; sessionId: string; sessionUrl: string }): Promise<AskOutcome> {
    if (!(await itemsDAO.findByOwnerAndId(body.itemId, userId))) {
        console.log('[claudeRoutine] item vanished while the Claude routine started', { userId, itemId: body.itemId, askId: session.askId });
        return { ok: false, rejection: ITEM_NOT_FOUND };
    }
    const recorded = await recordClaudeAsk({ ...session, userId, itemId: body.itemId, prompt: body.prompt, now: dayjs().toISOString() });
    clearClaudeAskStarting(userId, body.itemId);
    return { ok: true, ask: recorded };
}

/**
 * Session-authed (cookie) Claude routine endpoints — the Settings section and the item editor's
 * "Ask Claude" box. Not under /v1: a bearer caller (an agent) has no business storing the token
 * or starting sessions on the user's Claude subscription.
 */
export const claudeRoutineRoutes = new Hono<{ Variables: AuthVariables }>()
    .use('*', authenticateRequest)

    // GET /account/claude-routine — whether a Claude routine is connected (never the token).
    .get('/', async (c) => {
        const userId = c.get('session').user.id;
        return c.json(presentConnection(await loadConnection(userId)));
    })

    // PUT /account/claude-routine — connect or replace the Claude routine.
    .put('/', async (c) => {
        const userId = c.get('session').user.id;
        const parsed = parseConnectionBody(await c.req.json<unknown>().catch(() => null));
        if (!parsed.ok) {
            return c.json({ error: parsed.message, code: parsed.code }, 400);
        }
        return c.json(presentConnection(await saveConnection(userId, parsed.input)));
    })

    // DELETE /account/claude-routine — disconnect. Idempotent.
    .delete('/', async (c) => {
        await deleteConnection(c.get('session').user.id);
        return c.json(presentConnection(null));
    })

    // POST /account/claude-routine/asks — start the Claude routine for an item.
    .post('/asks', async (c) => {
        const userId = c.get('session').user.id;
        const parsed = parseAskBody(await c.req.json<unknown>().catch(() => null));
        const outcome = parsed.ok ? await askClaude(userId, parsed.body) : parsed;
        if (outcome.ok) {
            return c.json({ ask: outcome.ask }, 201);
        }
        const { status, code, message, retryAfterSeconds } = outcome.rejection;
        if (retryAfterSeconds) {
            c.header('Retry-After', String(retryAfterSeconds));
        }
        return c.json({ error: message, code }, status);
    });
