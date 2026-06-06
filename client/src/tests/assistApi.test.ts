/** Tests for the Lane A Claude-assist HTTP wrappers (`src/api/assistApi.ts`).
 * Same harness as `tokensApi.test.ts` — global fetch replaced per-test, then restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistApiError, applyProposal, assist, type ClarifyProposal } from '../api/assistApi';

interface FetchCall {
    url: string;
    init: RequestInit | undefined;
}

let fetchSpy: ReturnType<typeof vi.fn>;
const fetchCalls: FetchCall[] = [];

function recordFetchCall(input: RequestInfo | URL, init?: RequestInit) {
    fetchCalls.push({ url: typeof input === 'string' ? input : input.toString(), init });
}

beforeEach(() => {
    fetchCalls.length = 0;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SAMPLE_PROPOSAL: ClarifyProposal = {
    summary: 'Turn this into a next action.',
    proposedItemPatch: { title: 'Follow up with Dana', status: 'nextAction' },
    proposedSideEffects: [{ kind: 'itemPatch', preview: 'Update the item', executeToken: 'tok.abc' }],
};

describe('assist', () => {
    it('POSTs the itemId with credentials and returns the proposal', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse(SAMPLE_PROPOSAL));
        });
        const result = await assist('item-1');
        expect(result).toEqual(SAMPLE_PROPOSAL);
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/v1/claude/assist');
        expect(call.init?.method).toBe('POST');
        expect(call.init?.credentials).toBe('include');
        expect((call.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        expect(JSON.parse(call.init?.body as string)).toEqual({ itemId: 'item-1' });
    });

    it('includes instruction only when provided', async () => {
        fetchSpy
            .mockImplementationOnce((input, init) => {
                recordFetchCall(input, init);
                return Promise.resolve(makeJsonResponse(SAMPLE_PROPOSAL));
            })
            .mockImplementationOnce((input, init) => {
                recordFetchCall(input, init);
                return Promise.resolve(makeJsonResponse(SAMPLE_PROPOSAL));
            });
        await assist('item-1');
        await assist('item-1', 'make it a calendar event');
        const [first, second] = fetchCalls;
        if (!first || !second) throw new Error('expected two fetch calls');
        expect(JSON.parse(first.init?.body as string)).toEqual({ itemId: 'item-1' });
        expect(JSON.parse(second.init?.body as string)).toEqual({ itemId: 'item-1', instruction: 'make it a calendar event' });
    });

    it('throws AssistApiError carrying the server status, message, and code on the spend cap (402)', async () => {
        fetchSpy.mockImplementationOnce(() =>
            Promise.resolve(makeJsonResponse({ error: "You've reached today's limit.", code: 'daily_spend_cap_reached' }, 402)),
        );
        const err = await assist('item-1').catch((e) => e);
        expect(err).toBeInstanceOf(AssistApiError);
        expect(err).toMatchObject({ status: 402, message: "You've reached today's limit.", code: 'daily_spend_cap_reached' });
    });

    it('surfaces agent_timeout (504) and agent_error (502) codes', async () => {
        fetchSpy
            .mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'too long', code: 'agent_timeout' }, 504)))
            .mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'boom', code: 'agent_error' }, 502)));
        await expect(assist('item-1')).rejects.toMatchObject({ status: 504, code: 'agent_timeout' });
        await expect(assist('item-1')).rejects.toMatchObject({ status: 502, code: 'agent_error' });
    });

    it('throws AssistApiError with code=undefined when the error body is not JSON (network/proxy failure)', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('Bad Gateway', { status: 502 })));
        const err = await assist('item-1').catch((e) => e);
        expect(err).toBeInstanceOf(AssistApiError);
        expect((err as AssistApiError).status).toBe(502);
        expect((err as AssistApiError).code).toBeUndefined();
    });

    it('falls back to a synthetic message when the error body carries a code but no error string', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ code: 'agent_error' }, 502)));
        const err = await assist('item-1').catch((e) => e);
        expect(err).toMatchObject({ status: 502, code: 'agent_error', message: 'assist API error 502' });
    });
});

describe('applyProposal', () => {
    it('POSTs the executeToken + patch with credentials and returns the applied result', async () => {
        const applied = { applied: true as const, item: { id: 'item-1', status: 'nextAction' as const, title: 'Follow up with Dana' } };
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse(applied));
        });
        const result = await applyProposal('tok.abc', { title: 'Follow up with Dana', status: 'nextAction' });
        expect(result).toEqual(applied);
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/v1/claude/assist/apply');
        expect(call.init?.credentials).toBe('include');
        expect(JSON.parse(call.init?.body as string)).toEqual({ executeToken: 'tok.abc', patch: { title: 'Follow up with Dana', status: 'nextAction' } });
    });

    it('surfaces the expired-token (410) and target-mismatch (400) codes', async () => {
        fetchSpy
            .mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'expired', code: 'execute_token_expired' }, 410)))
            .mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'mismatch', code: 'execute_token_target_mismatch' }, 400)));
        await expect(applyProposal('tok.abc', { title: 'x' })).rejects.toMatchObject({ status: 410, code: 'execute_token_expired' });
        await expect(applyProposal('tok.abc', { title: 'x' })).rejects.toMatchObject({ status: 400, code: 'execute_token_target_mismatch' });
    });
});
