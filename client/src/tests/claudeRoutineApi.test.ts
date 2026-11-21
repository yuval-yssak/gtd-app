/** Tests for the Claude routine wrapper (`src/api/claudeRoutineApi.ts`). Global fetch is replaced per-test. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    askClaude,
    ClaudeRoutineApiError,
    disconnectClaudeRoutine,
    fetchClaudeRoutineConnection,
    isClaudeAskSnapshot,
    saveClaudeRoutineConnection,
} from '../api/claudeRoutineApi';

const fetchSpy = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;

beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const ASK = {
    _id: 'ask-1',
    user: 'u',
    itemId: 'item-1',
    prompt: 'Rename it',
    sessionId: 's',
    sessionUrl: 'https://claude.ai/code/s',
    createdTs: '2026-11-21T10:00:00.000Z',
    updatedTs: '2026-11-21T10:00:00.000Z',
};

async function captureError(run: () => Promise<unknown>): Promise<ClaudeRoutineApiError> {
    const err = await run().then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    if (!(err instanceof ClaudeRoutineApiError)) {
        throw new Error('expected a ClaudeRoutineApiError');
    }
    return err;
}

function lastCall() {
    const call = fetchSpy.mock.calls.at(-1);
    if (!call) {
        throw new Error('expected a fetch call');
    }
    const [input, init] = call;
    return { url: String(input), init };
}

describe('connection calls', () => {
    it('reads, saves and disconnects through /account/claude-routine with the session cookie', async () => {
        fetchSpy.mockResolvedValueOnce(json({ connected: false }));
        expect(await fetchClaudeRoutineConnection()).toEqual({ connected: false, claudeRoutineId: undefined, tokenHint: undefined, updatedTs: undefined });
        expect(lastCall().url).toMatch(/\/account\/claude-routine$/);
        expect(lastCall().init?.credentials).toBe('include');

        fetchSpy.mockResolvedValueOnce(json({ connected: true, claudeRoutineId: 'trig_1', tokenHint: 'abcd', updatedTs: 't' }));
        expect(await saveClaudeRoutineConnection({ claudeRoutineId: 'trig_1', token: 'sk-ant-oat01-xxxxxxxxxxxx' })).toMatchObject({
            connected: true,
            tokenHint: 'abcd',
        });
        expect(lastCall().init?.method).toBe('PUT');
        expect(JSON.parse(String(lastCall().init?.body))).toEqual({ claudeRoutineId: 'trig_1', token: 'sk-ant-oat01-xxxxxxxxxxxx' });

        fetchSpy.mockResolvedValueOnce(json({ connected: false }));
        expect(await disconnectClaudeRoutine()).toMatchObject({ connected: false });
        expect(lastCall().init?.method).toBe('DELETE');
    });

    it('surfaces the server code on a 400', async () => {
        fetchSpy.mockResolvedValueOnce(json({ error: 'bad id', code: 'invalid_claude_routine_id' }, 400));
        const err = await captureError(() => saveClaudeRoutineConnection({ claudeRoutineId: 'x', token: 'y' }));
        expect(err).toMatchObject({ status: 400, code: 'invalid_claude_routine_id', message: 'bad id' });
    });
});

describe('askClaude', () => {
    it('POSTs the item and prompt and returns the recorded ask', async () => {
        fetchSpy.mockResolvedValueOnce(json({ ask: ASK }, 201));
        expect(await askClaude('item-1', 'Rename it')).toEqual(ASK);
        expect(lastCall().url).toMatch(/\/account\/claude-routine\/asks$/);
        expect(JSON.parse(String(lastCall().init?.body))).toEqual({ itemId: 'item-1', prompt: 'Rename it' });
    });

    it('carries the rate-limit Retry-After, ignores unknown codes, and turns a network failure into status 0', async () => {
        fetchSpy.mockResolvedValueOnce(json({ code: 'claude_routine_rate_limited' }, 429, { 'Retry-After': '30' }));
        expect(await captureError(() => askClaude('i', 'p'))).toMatchObject({ status: 429, code: 'claude_routine_rate_limited', retryAfterSeconds: 30 });

        fetchSpy.mockResolvedValueOnce(json({ code: 'something_new' }, 500));
        expect((await captureError(() => askClaude('i', 'p'))).code).toBeUndefined();

        fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const networkError = await captureError(() => askClaude('i', 'p'));
        expect(networkError).toMatchObject({ status: 0 });
        expect(networkError.code).toBeUndefined();

        // AbortSignal.timeout: this device stopped waiting — the server may still have started it.
        fetchSpy.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
        expect(await captureError(() => askClaude('i', 'p'))).toMatchObject({ status: 0, code: 'timeout' });
    });

    it('rejects a 201 whose body is not an ask', async () => {
        fetchSpy.mockResolvedValueOnce(json({ ask: { ...ASK, sessionId: undefined } }, 201));
        expect((await captureError(() => askClaude('i', 'p'))).status).toBe(201);
    });
});

describe('isClaudeAskSnapshot', () => {
    it('accepts a row with or without a valid result and rejects an unknown outcome', () => {
        expect(isClaudeAskSnapshot(ASK)).toBe(true);
        expect(isClaudeAskSnapshot({ ...ASK, result: { summary: 's', outcome: 'needsInput', reportedTs: 't' } })).toBe(true);
        expect(isClaudeAskSnapshot({ ...ASK, result: { summary: 's', outcome: 'exploded', reportedTs: 't' } })).toBe(false);
        expect(isClaudeAskSnapshot(null)).toBe(false);
    });
});
