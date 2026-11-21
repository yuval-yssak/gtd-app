import { describe, expect, it, vi } from 'vitest';
import { ClaudeRoutineApiError, type ServerClaudeAskSnapshot } from '../api/claudeRoutineApi';
import {
    ASK_CLAUDE_EMPTY_TOOLTIP,
    ASK_CLAUDE_OFFLINE_TOOLTIP,
    ASK_CLAUDE_WAITING_LABEL,
    ASK_HISTORY_PREVIEW_COUNT,
    asksForItem,
    describeAskButton,
    describeAskError,
    describeAskResult,
    describePromptCounter,
    isAskClaudeAvailable,
    isClaudeSessionLink,
    isSubmitChord,
    visibleAsks,
} from '../components/itemEditor/askClaudeLogic';
import { runAskClaude } from '../components/itemEditor/askClaudeRunner';
import type { StoredClaudeAsk } from '../types/MyDB';

function ask(id: string, createdTs: string, overrides: Partial<StoredClaudeAsk> = {}): StoredClaudeAsk {
    return {
        _id: id,
        userId: 'u',
        itemId: 'item-1',
        prompt: `prompt ${id}`,
        sessionId: 's',
        sessionUrl: 'https://claude.ai/code/s',
        createdTs,
        updatedTs: createdTs,
        ...overrides,
    };
}

describe('asksForItem / visibleAsks', () => {
    it("keeps only this item's asks, newest first", () => {
        const rows = [ask('a', '2026-11-20T10:00:00.000Z'), ask('b', '2026-11-21T10:00:00.000Z'), ask('c', '2026-11-22T10:00:00.000Z', { itemId: 'other' })];
        expect(asksForItem(rows, 'item-1').map((row) => row._id)).toEqual(['b', 'a']);
    });

    it('shows a short preview until expanded', () => {
        const rows = Array.from({ length: ASK_HISTORY_PREVIEW_COUNT + 2 }, (_, i) => ask(String(i), `2026-11-2${i}T10:00:00.000Z`));
        expect(visibleAsks(rows, false)).toHaveLength(ASK_HISTORY_PREVIEW_COUNT);
        expect(visibleAsks(rows, true)).toHaveLength(rows.length);
    });
});

describe('describeAskResult', () => {
    it('reads waiting until Claude reports', () => {
        expect(describeAskResult(ask('a', 't'))).toEqual({ tone: 'waiting', text: ASK_CLAUDE_WAITING_LABEL });
    });

    it('marks a completed report with a check and a needs-input report with what Claude needs', () => {
        const completed = ask('a', 't', { result: { summary: 'Renamed it', outcome: 'completed', reportedTs: 't' } });
        const needsInput = ask('b', 't', { result: { summary: 'Which ticket?', outcome: 'needsInput', reportedTs: 't' } });
        expect(describeAskResult(completed)).toEqual({ tone: 'completed', text: '✓ Renamed it' });
        expect(describeAskResult(needsInput)).toEqual({ tone: 'needsInput', text: 'Needs your input: Which ticket?' });
    });
});

describe('describeAskButton', () => {
    it('is disabled offline, with an empty prompt, and while sending', () => {
        expect(describeAskButton({ isOnline: false, isSending: false, prompt: 'go' })).toEqual({ isDisabled: true, tooltip: ASK_CLAUDE_OFFLINE_TOOLTIP });
        expect(describeAskButton({ isOnline: true, isSending: false, prompt: '  ' })).toEqual({ isDisabled: true, tooltip: ASK_CLAUDE_EMPTY_TOOLTIP });
        expect(describeAskButton({ isOnline: true, isSending: true, prompt: 'go' })).toEqual({ isDisabled: true, tooltip: null });
        expect(describeAskButton({ isOnline: true, isSending: false, prompt: 'go' })).toEqual({ isDisabled: false, tooltip: null });
    });
});

describe('isSubmitChord', () => {
    it('accepts Cmd/Ctrl+Enter, never a plain Enter or a key repeat', () => {
        expect(isSubmitChord({ key: 'Enter', metaKey: true, ctrlKey: false, repeat: false })).toBe(true);
        expect(isSubmitChord({ key: 'Enter', metaKey: false, ctrlKey: true, repeat: false })).toBe(true);
        expect(isSubmitChord({ key: 'Enter', metaKey: false, ctrlKey: false, repeat: false })).toBe(false);
        expect(isSubmitChord({ key: 'Enter', metaKey: true, ctrlKey: false, repeat: true })).toBe(false);
    });
});

describe('describePromptCounter / isClaudeSessionLink', () => {
    it('shows a counter only near the limit', () => {
        expect(describePromptCounter('x'.repeat(100))).toBeNull();
        expect(describePromptCounter('x'.repeat(3600))).toBe('3600 / 4000');
    });

    it('links only https claude.ai session URLs', () => {
        expect(isClaudeSessionLink('https://claude.ai/code/session_1')).toBe(true);
        expect(isClaudeSessionLink('javascript:alert(1)')).toBe(false);
        expect(isClaudeSessionLink('https://claude.ai.evil.test/x')).toBe(false);
    });
});

describe('isAskClaudeAvailable', () => {
    it('hides the section only for trashed items', () => {
        expect(isAskClaudeAvailable('trash')).toBe(false);
        expect(isAskClaudeAvailable('done')).toBe(true);
        expect(isAskClaudeAvailable('inbox')).toBe(true);
    });
});

describe('describeAskError', () => {
    it.each([
        ['claude_routine_not_connected', true],
        ['claude_routine_token_rejected', true],
        ['claude_routine_not_found', true],
        ['claude_routine_unavailable', false],
        ['claude_ask_in_flight', false],
        ['claude_routine_unreachable', false],
    ] as const)('maps %s (settings fix: %s)', (code, isSettingsFix) => {
        const view = describeAskError(new ClaudeRoutineApiError('x', { status: 409, code }));
        expect(view.isSettingsFix).toBe(isSettingsFix);
        expect(view.message).not.toBe("Couldn't ask Claude. Try again.");
    });

    it('says a timed-out ask may already be starting, rather than "couldn\'t reach"', () => {
        const view = describeAskError(new ClaudeRoutineApiError('timed out', { status: 0, code: 'timeout' }));
        expect(view).toEqual({ message: 'Claude may already be starting — check the history below in a moment.', isSettingsFix: false });
    });

    it('names the Retry-After wait for a rate limit', () => {
        const err = new ClaudeRoutineApiError('x', { status: 429, code: 'claude_routine_rate_limited', retryAfterSeconds: 30 });
        expect(describeAskError(err).message).toContain('30 seconds');
    });

    it('explains a network failure and falls back for anything else', () => {
        expect(describeAskError(new ClaudeRoutineApiError('x', { status: 0 })).message).toContain("Couldn't reach");
        expect(describeAskError(new Error('boom'))).toEqual({ message: "Couldn't ask Claude. Try again.", isSettingsFix: false });
    });
});

describe('runAskClaude', () => {
    const row: ServerClaudeAskSnapshot = { ...ask('a', 't'), user: 'u' };

    it('flushes the item text before asking, stores the returned row, and reports the session link', async () => {
        const calls: string[] = [];
        const ports = {
            flushItemText: vi.fn(async () => void calls.push('flush')),
            ask: vi.fn(async (prompt: string) => {
                calls.push(`ask:${prompt}`);
                return row;
            }),
            store: vi.fn(async () => void calls.push('store')),
        };
        expect(await runAskClaude('  Rename it  ', ports)).toEqual({ kind: 'started', sessionUrl: row.sessionUrl });
        expect(calls).toEqual(['flush', 'ask:Rename it', 'store']);
    });

    it('settles a failure into the error view without storing anything', async () => {
        const store = vi.fn();
        const settlement = await runAskClaude('go', {
            flushItemText: async () => undefined,
            ask: async () => {
                throw new ClaudeRoutineApiError('x', { status: 409, code: 'claude_routine_not_connected' });
            },
            store,
        });
        expect(settlement).toMatchObject({ kind: 'failed', error: { isSettingsFix: true } });
        expect(store).not.toHaveBeenCalled();
    });
});
