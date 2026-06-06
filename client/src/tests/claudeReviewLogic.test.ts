/** Tests for the pure Claude review logic (`src/components/claudeReview/claudeReviewLogic.ts`). */
import { describe, expect, it } from 'vitest';
import type { AssistErrorCode } from '../api/assistApi';
import { applyPayloadEdit, describeError, hasAppliableWork } from '../components/claudeReview/claudeReviewLogic';

describe('describeError', () => {
    it('marks the spend cap non-retryable with tomorrow copy', () => {
        const view = describeError('daily_spend_cap_reached');
        expect(view.retryable).toBe(false);
        expect(view.message).toMatch(/tomorrow/i);
    });

    it('marks timeout and agent_error retryable', () => {
        expect(describeError('agent_timeout').retryable).toBe(true);
        expect(describeError('agent_error').retryable).toBe(true);
    });

    it('maps agent_unavailable to a friendly "temporarily unavailable" retryable message', () => {
        const view = describeError('agent_unavailable');
        expect(view.retryable).toBe(true);
        expect(view.message).toMatch(/temporarily unavailable/i);
    });

    it('keeps the three Claude-failure messages distinct (the whole point of the codes)', () => {
        const messages = new Set([
            describeError('agent_unavailable').message,
            describeError('agent_error').message,
            describeError('daily_spend_cap_reached').message,
        ]);
        expect(messages.size).toBe(3);
    });

    it('treats every expired/invalid token code as a retryable "re-run Clarify"', () => {
        const tokenCodes: AssistErrorCode[] = ['execute_token_expired', 'invalid_execute_token', 'execute_token_target_mismatch'];
        for (const code of tokenCodes) {
            const view = describeError(code);
            expect(view.retryable).toBe(true);
            expect(view.message).toMatch(/re-run/i);
        }
    });

    it('marks not-found and auth codes non-retryable', () => {
        expect(describeError('item_not_found').retryable).toBe(false);
        expect(describeError('not_found').retryable).toBe(false);
        expect(describeError('forbidden_scope').retryable).toBe(false);
        expect(describeError('unauthorized').retryable).toBe(false);
    });

    it('treats a code-less failure (network) as a generic retryable error', () => {
        const view = describeError(undefined);
        expect(view.retryable).toBe(true);
        expect(view.message).toMatch(/connection/i);
    });
});

describe('applyPayloadEdit', () => {
    it('overwrites one editable field immutably, leaving others intact', () => {
        const patch = { title: 'old', status: 'nextAction' as const };
        const next = applyPayloadEdit(patch, 'title', 'new');
        expect(next).toEqual({ title: 'new', status: 'nextAction' });
        expect(patch.title).toBe('old'); // original untouched
    });

    it('adds the field when the starting patch is empty', () => {
        expect(applyPayloadEdit({}, 'notes', 'a note')).toEqual({ notes: 'a note' });
    });
});

describe('hasAppliableWork', () => {
    it('is true only with a non-empty patch, a token present, and not skipped', () => {
        expect(hasAppliableWork({ title: 'x' }, true, false)).toBe(true);
    });

    it('is false when skipped, token-less, or the patch is empty/undefined', () => {
        expect(hasAppliableWork({ title: 'x' }, true, true)).toBe(false);
        expect(hasAppliableWork({ title: 'x' }, false, false)).toBe(false);
        expect(hasAppliableWork({}, true, false)).toBe(false);
        expect(hasAppliableWork(undefined, true, false)).toBe(false);
    });
});
