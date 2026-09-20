/** Tests for the on-demand brief generator wrapper (`src/api/briefApi.ts`).
 * Same harness as `assistApi.test.ts` — global fetch replaced per-test, then restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefApiError, generateBrief, type ServerItemBriefSnapshot } from '../api/briefApi';

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

function makeJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function respondWith(response: Response) {
    fetchSpy.mockImplementationOnce((input, init) => {
        recordFetchCall(input, init);
        return Promise.resolve(response);
    });
}

async function captureError(run: () => Promise<unknown>): Promise<BriefApiError> {
    const err = await run().then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    if (!(err instanceof BriefApiError)) throw new Error('expected a BriefApiError');
    return err;
}

const WRITTEN_ROW: ServerItemBriefSnapshot = {
    _id: 'item-1',
    itemId: 'item-1',
    user: 'user-1',
    text: '[fake] Renewal form is half filled in.',
    origin: 'model',
    model: 'fake',
    sourceHash: 'abc',
    generatedTs: '2026-09-20T10:00:00.000Z',
    createdTs: '2026-09-20T10:00:00.000Z',
    updatedTs: '2026-09-20T10:00:00.000Z',
};

describe('generateBrief', () => {
    it('POSTs { force } to the item-scoped route with credentials and returns the written row', async () => {
        respondWith(makeJsonResponse({ outcome: 'written', item: { id: 'item-1' }, brief: WRITTEN_ROW }));
        const result = await generateBrief('item-1');
        expect(result).toEqual({ outcome: 'written', brief: WRITTEN_ROW });
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/v1/items/item-1/brief/generate');
        expect(call.init?.method).toBe('POST');
        expect(call.init?.credentials).toBe('include');
        expect(JSON.parse(call.init?.body as string)).toEqual({ force: false });
    });

    it('arms a client-side deadline so a black-holed request cannot hang the button forever', async () => {
        respondWith(makeJsonResponse({ outcome: 'written', brief: WRITTEN_ROW }));
        await generateBrief('item-1');
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('rejects a row whose origin is not one the client knows', async () => {
        respondWith(makeJsonResponse({ outcome: 'written', brief: { ...WRITTEN_ROW, origin: 'oracle' } }));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.status).toBe(200);
    });

    it('sends force: true when asked and URL-encodes the item id', async () => {
        respondWith(makeJsonResponse({ outcome: 'written', brief: WRITTEN_ROW }));
        await generateBrief('a/b', { force: true });
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/v1/items/a%2Fb/brief/generate');
        expect(JSON.parse(call.init?.body as string)).toEqual({ force: true });
    });

    it('returns the skipped outcome with the text: null row verbatim', async () => {
        const skippedRow = { ...WRITTEN_ROW, text: null, origin: 'skipped' as const };
        respondWith(makeJsonResponse({ outcome: 'skipped', brief: skippedRow }));
        const result = await generateBrief('item-1');
        expect(result).toEqual({ outcome: 'skipped', brief: skippedRow });
    });

    it('returns discarded_stale with brief: null', async () => {
        respondWith(makeJsonResponse({ outcome: 'discarded_stale', brief: null }));
        expect(await generateBrief('item-1')).toEqual({ outcome: 'discarded_stale', brief: null });
    });

    it('rejects a 200 body that contradicts the contract (written without a row)', async () => {
        respondWith(makeJsonResponse({ outcome: 'written', brief: null }));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.status).toBe(200);
        expect(err.code).toBeUndefined();
    });

    it('throws BriefApiError with code brief_pinned on 409', async () => {
        respondWith(makeJsonResponse({ error: 'pinned', code: 'brief_pinned' }, 409));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.status).toBe(409);
        expect(err.code).toBe('brief_pinned');
        expect(err.message).toBe('pinned');
        expect(err.retryAfterSeconds).toBeUndefined();
    });

    it('carries Retry-After seconds on 429', async () => {
        respondWith(makeJsonResponse({ error: 'slow down', code: 'rate_limited' }, 429, { 'Retry-After': '42' }));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.status).toBe(429);
        expect(err.code).toBe('rate_limited');
        expect(err.retryAfterSeconds).toBe(42);
    });

    it('reads an unparsable Retry-After as unknown', async () => {
        respondWith(makeJsonResponse({ code: 'rate_limited' }, 429, { 'Retry-After': 'soon' }));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.retryAfterSeconds).toBeUndefined();
    });

    it('surfaces agent_unavailable on 503', async () => {
        respondWith(makeJsonResponse({ error: 'no key', code: 'agent_unavailable' }, 503));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.status).toBe(503);
        expect(err.code).toBe('agent_unavailable');
    });

    it('falls back to code=undefined and a status message when the error body is not JSON', async () => {
        respondWith(new Response('<html>bad gateway</html>', { status: 502 }));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.status).toBe(502);
        expect(err.code).toBeUndefined();
        expect(err.message).toBe('brief API error 502');
    });

    it('drops an unknown server code rather than trusting it', async () => {
        respondWith(makeJsonResponse({ code: 'something_new' }, 500));
        const err = await captureError(() => generateBrief('item-1'));
        expect(err.code).toBeUndefined();
    });
});
