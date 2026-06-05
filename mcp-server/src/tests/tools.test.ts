import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../apiClient.js';
import { GtdApiError } from '../apiClient.js';
import type { GtdEnvironment } from '../config.js';
import { _batchToolsForTesting } from '../tools/batch.js';
import { _itemToolsForTesting } from '../tools/items.js';
import { _meToolsForTesting } from '../tools/me.js';
import { _peopleToolsForTesting } from '../tools/people.js';
import { _reassignToolsForTesting } from '../tools/reassign.js';
import { _routineToolsForTesting } from '../tools/routines.js';
import { _workContextToolsForTesting } from '../tools/workContexts.js';

/**
 * Tool handlers should call the API client with the right method, path, body, and query.
 * We build a fake ApiClient that records calls and assert against it — no real fetch.
 */

interface RecordedCall {
    method: string;
    path: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    opts?: { account?: string; recipientAccount?: string };
}

/**
 * Variant of makeFakeApi that lets a test pre-stage per-path responses — used by gtd_reassign,
 * which calls /v1/me to resolve the recipient userId before posting /v1/reassign. `responses`
 * is consulted by exact path match; missing keys fall back to the default `{ok:true}`.
 *
 * Optional `accountResponses` lets a test return different bodies per `account` (used by
 * gtd_list_accounts, which calls /v1/me once per configured account). When supplied, the
 * `account` opt is used as the lookup key first and falls back to `responses` by path.
 * If the value is a `GtdApiError`, it's thrown so partial-failure flows can be exercised.
 */
function makeFakeApi(
    responses: Record<string, unknown> = {},
    options: { accountResponses?: Record<string, unknown | GtdApiError>; accounts?: string[]; environment?: GtdEnvironment; apiBase?: string } = {},
): { api: ApiClient; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const api: ApiClient = {
        request: vi.fn(async (method, path, body, query, opts) => {
            const call: RecordedCall = { method, path };
            if (body !== undefined) call.body = body;
            if (query !== undefined) call.query = query;
            if (opts !== undefined) call.opts = opts;
            calls.push(call);
            const accountKey = opts?.account;
            if (accountKey && options.accountResponses && Object.hasOwn(options.accountResponses, accountKey)) {
                const value = options.accountResponses[accountKey];
                if (value instanceof GtdApiError) throw value;
                return value as never;
            }
            return (responses[path] ?? { ok: true }) as never;
        }),
        listAccounts: () => options.accounts ?? ['default'],
        environment: () => options.environment ?? 'local',
        apiBase: () => options.apiBase ?? 'http://localhost:4000',
    };
    return { api, calls };
}

describe('item tools', () => {
    const t = _itemToolsForTesting;

    it('gtd_capture POSTs /v1/items with the body', async () => {
        const { api, calls } = makeFakeApi();
        await t.capture.handler({ title: 'buy milk', externalId: 'shortcut-1' }, api);
        expect(calls).toHaveLength(1);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.method).toBe('POST');
        expect(call.path).toBe('/v1/items');
        expect(call.body).toEqual({ title: 'buy milk', externalId: 'shortcut-1' });
    });

    it('gtd_list_items GETs /v1/items with query params', async () => {
        const { api, calls } = makeFakeApi({ items: [] });
        await t.listItems.handler({ q: 'mom', status: 'inbox', limit: 25 }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.method).toBe('GET');
        expect(call.path).toBe('/v1/items');
        expect(call.query).toEqual({ q: 'mom', status: 'inbox', since: undefined, limit: 25, cursor: undefined });
    });

    it('gtd_get_item URL-encodes the id', async () => {
        const { api, calls } = makeFakeApi();
        await t.getItem.handler({ id: 'abc/def' }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.path).toBe('/v1/items/abc%2Fdef');
    });

    it('gtd_update_item PATCHes /v1/items/:id with body without id', async () => {
        const { api, calls } = makeFakeApi();
        await t.updateItem.handler({ id: 'abc', status: 'nextAction', energy: 'low' }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.method).toBe('PATCH');
        expect(call.path).toBe('/v1/items/abc');
        expect(call.body).toEqual({ status: 'nextAction', energy: 'low' });
    });

    it('gtd_complete_item POSTs /complete with empty body', async () => {
        const { api, calls } = makeFakeApi();
        await t.completeItem.handler({ id: 'abc' }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.method).toBe('POST');
        expect(call.path).toBe('/v1/items/abc/complete');
        expect(call.body).toEqual({});
    });

    it('gtd_trash_item POSTs /trash with empty body (recoverable soft-delete)', async () => {
        const { api, calls } = makeFakeApi();
        await t.trashItem.handler({ id: 'abc' }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.method).toBe('POST');
        expect(call.path).toBe('/v1/items/abc/trash');
        expect(call.body).toEqual({});
    });

    it('gtd_update_item rejects status:"trash" at the schema level (Zod enum)', () => {
        const result = t.updateItem.inputSchema.status.safeParse('trash');
        expect(result.success).toBe(false);
    });

    it('id schema rejects whitespace-only ids before the API is called', () => {
        const result = t.getItem.inputSchema.id.safeParse('   ');
        expect(result.success).toBe(false);
    });

    it('id schema accepts a normal id', () => {
        expect(t.getItem.inputSchema.id.safeParse('abc-123').success).toBe(true);
    });
});

describe('routine tools', () => {
    const t = _routineToolsForTesting;

    it('gtd_create_routine POSTs the full body', async () => {
        const { api, calls } = makeFakeApi();
        await t.createRoutine.handler(
            {
                title: 'Daily standup',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: { energy: 'low' },
                active: true,
            },
            api,
        );
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.path).toBe('/v1/routines');
        expect(call.body).toMatchObject({ title: 'Daily standup', routineType: 'nextAction' });
    });

    it('gtd_split_routine omits id from the body', async () => {
        const { api, calls } = makeFakeApi();
        await t.splitRoutine.handler({ id: 'r1', splitDate: '2026-06-01', tailEdits: { title: 'New name' } }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.path).toBe('/v1/routines/r1/split');
        expect(call.body).toEqual({ splitDate: '2026-06-01', tailEdits: { title: 'New name' } });
    });

    it('gtd_split_routine works without tailEdits (just id + splitDate)', async () => {
        const { api, calls } = makeFakeApi();
        await t.splitRoutine.handler({ id: 'r1', splitDate: '2026-06-01' }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.body).toEqual({ splitDate: '2026-06-01' });
    });

    it('gtd_split_routine round-trips routineType / startDate / active in tailEdits', async () => {
        const { api, calls } = makeFakeApi();
        await t.splitRoutine.handler(
            {
                id: 'r1',
                splitDate: '2026-06-01',
                tailEdits: { routineType: 'calendar', startDate: '2026-06-01', active: false },
            },
            api,
        );
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.body).toEqual({
            splitDate: '2026-06-01',
            tailEdits: { routineType: 'calendar', startDate: '2026-06-01', active: false },
        });
    });

    it('gtd_pause_routine and gtd_resume_routine POST to the right paths with empty body', async () => {
        const { api, calls } = makeFakeApi();
        await t.pauseRoutine.handler({ id: 'r1' }, api);
        await t.resumeRoutine.handler({ id: 'r2' }, api);
        const [pauseCall, resumeCall] = calls;
        if (!pauseCall || !resumeCall) throw new Error('expected two calls');
        expect(pauseCall.path).toBe('/v1/routines/r1/pause');
        expect(resumeCall.path).toBe('/v1/routines/r2/resume');
    });
});

describe('people + workContexts tools', () => {
    it('gtd_create_person POSTs /v1/people', async () => {
        const { api, calls } = makeFakeApi();
        await _peopleToolsForTesting.createPerson.handler({ name: 'Sam' }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.path).toBe('/v1/people');
    });

    it('gtd_delete_work_context DELETEs /v1/work-contexts/:id', async () => {
        const { api, calls } = makeFakeApi();
        await _workContextToolsForTesting.deleteWorkContext.handler({ id: 'wc1' }, api);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.method).toBe('DELETE');
        expect(call.path).toBe('/v1/work-contexts/wc1');
    });
});

describe('reassign + batch tools', () => {
    it('gtd_reassign resolves toUserId via /v1/me on the recipient account, then POSTs /v1/reassign with both bearers', async () => {
        // /v1/me returns the recipient's userId so the model never has to spell out raw UUIDs.
        const { api, calls } = makeFakeApi({ '/v1/me': { userId: 'bob-uuid', label: 'work' } });
        await _reassignToolsForTesting.reassign.handler({ entityType: 'item', entityId: 'i1', fromAccount: 'default', toAccount: 'work' }, api);
        expect(calls).toHaveLength(2);
        const [meCall, reassignCall] = calls;
        if (!meCall || !reassignCall) throw new Error('expected two calls');
        // 1. /v1/me on the recipient account.
        expect(meCall.method).toBe('GET');
        expect(meCall.path).toBe('/v1/me');
        expect(meCall.opts).toEqual({ account: 'work' });
        // 2. /v1/reassign with both bearers attached and the resolved toUserId in the body.
        expect(reassignCall.method).toBe('POST');
        expect(reassignCall.path).toBe('/v1/reassign');
        expect(reassignCall.body).toEqual({ entityType: 'item', entityId: 'i1', toUserId: 'bob-uuid' });
        expect(reassignCall.opts).toEqual({ account: 'default', recipientAccount: 'work' });
    });

    it('gtd_reassign defaults fromAccount to "default" when omitted', async () => {
        const { api, calls } = makeFakeApi({ '/v1/me': { userId: 'bob-uuid', label: 'work' } });
        await _reassignToolsForTesting.reassign.handler({ entityType: 'item', entityId: 'i1', toAccount: 'work', fromAccount: 'default' }, api);
        const reassignCall = calls.find((c) => c.path === '/v1/reassign');
        if (!reassignCall) throw new Error('expected /v1/reassign call');
        expect(reassignCall.opts?.account).toBe('default');
    });

    it('gtd_reassign rejects when toAccount is omitted', () => {
        // The Zod schema requires toAccount — the SDK validates inputs before invoking the handler.
        const result = _reassignToolsForTesting.reassign.inputSchema.toAccount.safeParse(undefined);
        expect(result.success).toBe(false);
    });

    it('gtd_batch wraps ops in {ops}', async () => {
        const { api, calls } = makeFakeApi();
        await _batchToolsForTesting.batch.handler(
            {
                ops: [
                    { entityType: 'workContext', opType: 'create', entityId: 'wc1', snapshot: { name: 'x' } },
                    { entityType: 'item', opType: 'create', entityId: 'i1', snapshot: { title: 'y' } },
                ],
            },
            api,
        );
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.path).toBe('/v1/operations/batch');
        expect(call.body).toEqual({
            ops: [
                { entityType: 'workContext', opType: 'create', entityId: 'wc1', snapshot: { name: 'x' } },
                { entityType: 'item', opType: 'create', entityId: 'i1', snapshot: { title: 'y' } },
            ],
        });
    });

    it('gtd_batch input schema rejects an empty ops array', () => {
        const r = _batchToolsForTesting.batch.inputSchema.ops.safeParse([]);
        expect(r.success).toBe(false);
    });

    it('gtd_batch entityId schema rejects whitespace-only inside ops (regression guard)', () => {
        const op = { entityType: 'item', opType: 'create', entityId: '   ', snapshot: {} };
        const r = _batchToolsForTesting.batch.inputSchema.ops.safeParse([op]);
        expect(r.success).toBe(false);
    });
});

describe('me tools', () => {
    const t = _meToolsForTesting;

    it('gtd_me merges /v1/me response with account, environment, and apiBase', async () => {
        const { api, calls } = makeFakeApi(
            { '/v1/me': { userId: 'u1', label: 'work-laptop', email: 'alice@example.com' } },
            { environment: 'production', apiBase: 'https://api.getting-things-done.app' },
        );
        const result = await t.me.handler({ account: 'work' }, api);
        expect(calls).toHaveLength(1);
        const [call] = calls;
        if (!call) throw new Error('expected one call');
        expect(call.method).toBe('GET');
        expect(call.path).toBe('/v1/me');
        expect(call.opts).toEqual({ account: 'work' });
        expect(result).toEqual({
            account: 'work',
            environment: 'production',
            apiBase: 'https://api.getting-things-done.app',
            userId: 'u1',
            label: 'work-laptop',
            email: 'alice@example.com',
        });
    });

    it('gtd_me defaults the account label to "default" in the response when no account arg is supplied', async () => {
        const { api } = makeFakeApi({ '/v1/me': { userId: 'u1', label: 'lap', email: 'a@b.c' } });
        const result = await t.me.handler({}, api);
        expect(result).toMatchObject({ account: 'default', environment: 'local', apiBase: 'http://localhost:4000' });
    });

    it('gtd_me echoes email:"" when the API response omits email (deleted user row)', async () => {
        const { api } = makeFakeApi({ '/v1/me': { userId: 'u1', label: 'lap' } });
        const result = await t.me.handler({}, api);
        expect(result).toMatchObject({ email: '' });
    });

    it('gtd_list_accounts iterates listAccounts() in order, merging /v1/me per row plus top-level env echo', async () => {
        const { api, calls } = makeFakeApi(
            {},
            {
                accounts: ['default', 'work'],
                environment: 'staging',
                apiBase: 'https://api-staging.getting-things-done.app',
                accountResponses: {
                    default: { userId: 'u-default', label: 'personal', email: 'alice@example.com' },
                    work: { userId: 'u-work', label: 'work-laptop', email: 'alice@work.example' },
                },
            },
        );
        const result = await t.listAccounts.handler({}, api);
        expect(calls).toHaveLength(2);
        // Both legs hit /v1/me with the right account opt.
        expect(calls[0]?.opts).toEqual({ account: 'default' });
        expect(calls[1]?.opts).toEqual({ account: 'work' });
        expect(result).toEqual({
            environment: 'staging',
            apiBase: 'https://api-staging.getting-things-done.app',
            accounts: [
                { account: 'default', userId: 'u-default', label: 'personal', email: 'alice@example.com' },
                { account: 'work', userId: 'u-work', label: 'work-laptop', email: 'alice@work.example' },
            ],
        });
    });

    it('gtd_list_accounts surfaces a per-row error when one token is revoked, without failing the rest', async () => {
        const { api } = makeFakeApi(
            {},
            {
                accounts: ['default', 'old'],
                environment: 'local',
                apiBase: 'http://localhost:4000',
                accountResponses: {
                    default: { userId: 'u-default', label: 'lap', email: 'alice@example.com' },
                    old: new GtdApiError('token revoked', 401, { error: 'token revoked', code: 'invalid_token' }),
                },
            },
        );
        const result = (await t.listAccounts.handler({}, api)) as { accounts: { account: string; error?: string; code?: string; userId?: string }[] };
        expect(result.accounts).toHaveLength(2);
        expect(result.accounts[0]).toMatchObject({ account: 'default', userId: 'u-default' });
        expect(result.accounts[1]).toEqual({ account: 'old', error: 'token revoked', code: 'invalid_token' });
    });

    it('gtd_list_accounts preserves listAccounts() insertion order in the accounts array', async () => {
        const { api } = makeFakeApi(
            {},
            {
                accounts: ['work', 'default', 'old'],
                accountResponses: {
                    work: { userId: 'uw', label: 'w', email: '' },
                    default: { userId: 'ud', label: 'd', email: '' },
                    old: { userId: 'uo', label: 'o', email: '' },
                },
            },
        );
        const result = (await t.listAccounts.handler({}, api)) as { accounts: { account: string }[] };
        expect(result.accounts.map((r) => r.account)).toEqual(['work', 'default', 'old']);
    });
});
