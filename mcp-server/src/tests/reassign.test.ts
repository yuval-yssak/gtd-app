import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../apiClient.js';
import { _reassignToolsForTesting } from '../tools/reassign.js';

/**
 * Focused coverage for the gtd_reassign tool. The tool's load-bearing behaviour is the
 * `/v1/me`-then-`/v1/reassign` choreography that resolves the recipient userId server-side
 * so the model never has to know raw Better Auth UUIDs. Verified end-to-end: input schema,
 * call ordering, and header propagation.
 */

interface RecordedCall {
    method: string;
    path: string;
    body?: unknown;
    opts?: { account?: string; recipientAccount?: string };
}

function makeStubApi(meResponse: { userId: string; label: string }): { api: ApiClient; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const api: ApiClient = {
        request: vi.fn(async (method, path, body, _query, opts) => {
            const call: RecordedCall = { method, path };
            if (body !== undefined) call.body = body;
            if (opts !== undefined) call.opts = opts;
            calls.push(call);
            if (path === '/v1/me') {
                return meResponse as never;
            }
            return { ok: true } as never;
        }),
    };
    return { api, calls };
}

describe('gtd_reassign tool', () => {
    it('resolves toUserId from the recipient token via /v1/me before posting /v1/reassign', async () => {
        const { api, calls } = makeStubApi({ userId: 'bob-uuid', label: 'work' });
        await _reassignToolsForTesting.reassign.handler({ entityType: 'item', entityId: 'i1', fromAccount: 'default', toAccount: 'work' }, api);
        // Ordering matters: /v1/me must precede /v1/reassign so the resolved userId can be
        // injected into the body.
        expect(calls.map((c) => c.path)).toEqual(['/v1/me', '/v1/reassign']);
        const reassignCall = calls[1];
        if (!reassignCall) throw new Error('expected reassign call');
        expect(reassignCall.body).toMatchObject({ entityType: 'item', entityId: 'i1', toUserId: 'bob-uuid' });
    });

    it('attaches the recipient token via X-Reassign-Recipient-Token, not the body', async () => {
        const { api, calls } = makeStubApi({ userId: 'bob-uuid', label: 'work' });
        await _reassignToolsForTesting.reassign.handler({ entityType: 'routine', entityId: 'r1', fromAccount: 'default', toAccount: 'work' }, api);
        const reassignCall = calls.find((c) => c.path === '/v1/reassign');
        if (!reassignCall) throw new Error('expected reassign call');
        expect(reassignCall.opts).toEqual({ account: 'default', recipientAccount: 'work' });
        // The body must NOT carry a raw recipient token — it goes via the header only.
        expect(reassignCall.body).not.toHaveProperty('recipientToken');
    });

    it("defaults fromAccount to 'default' so single-line MCP calls work", async () => {
        const { api, calls } = makeStubApi({ userId: 'bob-uuid', label: 'work' });
        // Mirroring how the SDK invokes a tool: the runtime applies Zod defaults before the
        // handler runs, so we exercise the schema-default path.
        const parsed = _reassignToolsForTesting.reassign.inputSchema.fromAccount.parse(undefined);
        expect(parsed).toBe('default');
        await _reassignToolsForTesting.reassign.handler({ entityType: 'item', entityId: 'i1', fromAccount: parsed, toAccount: 'work' }, api);
        const reassignCall = calls.find((c) => c.path === '/v1/reassign');
        if (!reassignCall) throw new Error('expected reassign call');
        expect(reassignCall.opts?.account).toBe('default');
    });

    it('refuses to construct an input without toAccount (Zod schema enforcement)', () => {
        const result = _reassignToolsForTesting.reassign.inputSchema.toAccount.safeParse(undefined);
        expect(result.success).toBe(false);
    });
});
