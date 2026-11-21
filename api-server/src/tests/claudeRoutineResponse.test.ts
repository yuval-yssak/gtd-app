import { describe, expect, it } from 'vitest';
import { classifyClaudeRoutineResponse } from '../lib/claudeRoutine/claudeRoutineResponse.js';

const SESSION = { type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' };

describe('classifyClaudeRoutineResponse', () => {
    it('returns the started session on 200', () => {
        expect(classifyClaudeRoutineResponse(200, SESSION, null)).toEqual({ ok: true, sessionId: 'session_1', sessionUrl: 'https://claude.ai/code/session_1' });
    });

    it.each([
        [401, 'claude_routine_token_rejected', 422],
        [403, 'claude_routine_token_rejected', 422],
        [404, 'claude_routine_not_found', 422],
        [400, 'claude_routine_unavailable', 422],
        [500, 'claude_routine_unreachable', 503],
        [503, 'claude_routine_unreachable', 503],
    ])('maps upstream %i to %s (%i)', (status, code, mapped) => {
        expect(classifyClaudeRoutineResponse(status, {}, null)).toEqual({ ok: false, failure: { code, status: mapped } });
    });

    it('maps 429 with its Retry-After seconds', () => {
        expect(classifyClaudeRoutineResponse(429, {}, '12')).toEqual({
            ok: false,
            failure: { code: 'claude_routine_rate_limited', status: 429, retryAfterSeconds: 12 },
        });
        expect(classifyClaudeRoutineResponse(429, {}, 'soon')).toMatchObject({ failure: { retryAfterSeconds: null } });
    });

    it.each([
        ['no body', null],
        ['missing session id', { ...SESSION, claude_code_session_id: '' }],
        ['non-claude link', { ...SESSION, claude_code_session_url: 'https://evil.test/x' }],
        ['http link', { ...SESSION, claude_code_session_url: 'http://claude.ai/code/session_1' }],
        ['look-alike host suffix', { ...SESSION, claude_code_session_url: 'https://claude.ai.evil.test/x' }],
        ['look-alike host prefix', { ...SESSION, claude_code_session_url: 'https://evilclaude.ai/x' }],
    ])('treats a 2xx with %s as unreachable', (_label, body) => {
        expect(classifyClaudeRoutineResponse(200, body, null)).toEqual({ ok: false, failure: { code: 'claude_routine_unreachable', status: 503 } });
    });
});
