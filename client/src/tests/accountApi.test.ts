/** Tests for the account-lifecycle HTTP wrappers (`src/api/accountApi.ts`).
 * Same harness as `devicesApi.test.ts` — global fetch replaced per-test, then restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountApiError, deleteMyAccount, downloadMyData, exportFilenameFromHeader, fetchUserStatus, SESSION_MISMATCH_CODE } from '../api/accountApi';

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
    // stubGlobal (not assignment) so afterEach's unstubAllGlobals restores the real fetch.
    vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** Awaits a rejection and narrows it to AccountApiError via instanceof — no cast at the assertion site. */
async function expectAccountApiError(promise: Promise<unknown>): Promise<AccountApiError> {
    const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
    );
    if (!(error instanceof AccountApiError)) {
        throw new Error(`expected an AccountApiError rejection, got ${String(error)}`);
    }
    return error;
}

function makeJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function singleCall(): FetchCall {
    expect(fetchCalls).toHaveLength(1);
    const [call] = fetchCalls;
    if (!call) throw new Error('expected one fetch call');
    return call;
}

describe('fetchUserStatus', () => {
    it('GETs /auth/user-status with the userId and WITHOUT credentials', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ status: 'deleted', deletedAt: '2026-10-04T00:00:00.000Z' }));
        });
        const result = await fetchUserStatus('user a');
        expect(result).toEqual({ status: 'deleted', deletedAt: '2026-10-04T00:00:00.000Z' });
        const call = singleCall();
        expect(call.url).toMatch(/\/auth\/user-status\?userId=user%20a$/);
        // The year-old device has no live cookie — the probe must not depend on one.
        expect(call.init?.credentials).toBe('omit');
    });

    it('returns active verbatim', async () => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ status: 'active' }));
        expect(await fetchUserStatus('u')).toEqual({ status: 'active' });
    });

    it.each([429, 500, 400])('fails open to unknown on HTTP %i', async (status) => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ error: 'nope' }, status));
        expect(await fetchUserStatus('u')).toEqual({ status: 'unknown' });
    });

    it('fails open to unknown on a network error', async () => {
        fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await fetchUserStatus('u')).toEqual({ status: 'unknown' });
    });

    it('fails open to unknown when the probe times out, and sends an abort signal so it can', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
        expect(await fetchUserStatus('u')).toEqual({ status: 'unknown' });
        expect(singleCall().init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('fails open to unknown on an unrecognised body — never invents a deletion', async () => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ status: 'gone' }));
        expect(await fetchUserStatus('u')).toEqual({ status: 'unknown' });
        fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }));
        expect(await fetchUserStatus('u')).toEqual({ status: 'unknown' });
    });
});

describe('deleteMyAccount', () => {
    it('sends DELETE /auth/me?expectedUserId= with credentials and returns the deleted id', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true, deletedUserId: 'user-a' }));
        });
        expect(await deleteMyAccount('user-a')).toEqual({ deletedUserId: 'user-a' });
        const call = singleCall();
        expect(call.url).toMatch(/\/auth\/me\?expectedUserId=user-a$/);
        expect(call.init?.method).toBe('DELETE');
        expect(call.init?.credentials).toBe('include');
    });

    it('throws AccountApiError carrying the status on failure', async () => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ error: 'Unauthorized: No session' }, 401));
        const error = await expectAccountApiError(deleteMyAccount('user-a'));
        expect(error.status).toBe(401);
        expect(error.message).toBe('Unauthorized: No session');
    });

    it('surfaces a 409 session_mismatch with its code and the account the cookie resolved to', async () => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ error: 'session mismatch', code: 'session_mismatch', sessionUserId: 'user-b' }, 409));
        const error = await expectAccountApiError(deleteMyAccount('user-a'));
        expect(error.status).toBe(409);
        expect(error.code).toBe(SESSION_MISMATCH_CODE);
        expect(error.sessionUserId).toBe('user-b');
    });

    it('rejects a 200 whose body carries no string deletedUserId instead of trusting it', async () => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ ok: true }));
        const error = await expectAccountApiError(deleteMyAccount('user-a'));
        expect(error.message).toMatch(/Unexpected response/);
    });
});

describe('exportFilenameFromHeader', () => {
    it('reads a quoted filename', () => {
        expect(exportFilenameFromHeader('attachment; filename="done-export-2026-10-04.json"', '2000-01-01')).toBe('done-export-2026-10-04.json');
    });

    it('reads an unquoted filename', () => {
        expect(exportFilenameFromHeader('attachment; filename=export.json', '2000-01-01')).toBe('export.json');
    });

    it('falls back to a dated default when the header is missing or has no filename', () => {
        expect(exportFilenameFromHeader(null, '2026-10-04')).toBe('done-export-2026-10-04.json');
        expect(exportFilenameFromHeader('attachment', '2026-10-04')).toBe('done-export-2026-10-04.json');
    });
});

describe('downloadMyData', () => {
    it('GETs /export with credentials and saves the body under the server-provided filename', async () => {
        const clickedDownloads: string[] = [];
        const anchorFactory = () => {
            const anchor = { href: '', download: '', click: vi.fn() };
            anchor.click.mockImplementation(() => clickedDownloads.push(anchor.download));
            return anchor;
        };
        vi.stubGlobal('document', { createElement: vi.fn(anchorFactory) });
        const createObjectURL = vi.fn(() => 'blob:fake-url');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ items: [] }, 200, { 'Content-Disposition': 'attachment; filename="done-export-2026-10-04.json"' }));
        });

        await downloadMyData('user-a');

        const call = singleCall();
        expect(call.url).toMatch(/\/export\?expectedUserId=user-a$/);
        expect(call.init?.credentials).toBe('include');
        expect(clickedDownloads).toEqual(['done-export-2026-10-04.json']);
        expect(createObjectURL).toHaveBeenCalledOnce();
        // Revocation is deferred a tick — Safari cancels a download whose URL is revoked synchronously.
        expect(revokeObjectURL).not.toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-url');
    });

    it('throws AccountApiError and downloads nothing on failure', async () => {
        const createElement = vi.fn();
        vi.stubGlobal('document', { createElement });
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, 500));
        const error = await expectAccountApiError(downloadMyData('user-a'));
        expect(error.status).toBe(500);
        expect(createElement).not.toHaveBeenCalled();
    });
});
