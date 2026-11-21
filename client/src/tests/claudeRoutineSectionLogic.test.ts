import { describe, expect, it } from 'vitest';
import { ClaudeRoutineApiError } from '../api/claudeRoutineApi';
import {
    CLAUDE_ROUTINE_LOAD_ERROR,
    describeConnectionError,
    describeLoadError,
    describeStoredConnection,
    SUGGESTED_CLAUDE_ROUTINE_PROMPT,
    validateConnectionDraft,
} from '../components/settings/claudeRoutineSectionLogic';

describe('validateConnectionDraft', () => {
    it('accepts a trig_ id and an sk-ant-oat01 token (trimmed)', () => {
        expect(validateConnectionDraft({ claudeRoutineId: ' trig_01ABC ', token: ' sk-ant-oat01-abcdefghijkl ' })).toBeNull();
    });

    it('names the field that is wrong', () => {
        expect(validateConnectionDraft({ claudeRoutineId: 'routine', token: 'sk-ant-oat01-abcdefghijkl' })).toMatchObject({
            field: 'claudeRoutineId',
            message: expect.stringContaining('trig_'),
        });
        expect(validateConnectionDraft({ claudeRoutineId: 'trig_1', token: 'sk-ant-api03-abcdefghijkl' })).toMatchObject({
            field: 'token',
            message: expect.stringContaining('sk-ant-oat01-'),
        });
    });
});

describe('describeStoredConnection', () => {
    it('shows the id and only the last four characters of the token', () => {
        expect(describeStoredConnection('trig_01ABC', '1a2b')).toBe('trig_01ABC · token ••••1a2b');
    });
});

describe('describeConnectionError', () => {
    it('passes the server wording through for a shape rejection, explains a network failure, and falls back', () => {
        expect(
            describeConnectionError(new ClaudeRoutineApiError('claudeRoutineId must look like trig_…', { status: 400, code: 'invalid_claude_routine_id' })),
        ).toBe('claudeRoutineId must look like trig_…');
        expect(describeConnectionError(new ClaudeRoutineApiError('x', { status: 0 }))).toContain("Couldn't reach");
        expect(describeConnectionError(new Error('x'))).toBe("Couldn't update the Claude routine. Try again.");
    });
});

describe('SUGGESTED_CLAUDE_ROUTINE_PROMPT', () => {
    it('tells Claude to follow the payload and to report back through done_report_claude_ask', () => {
        expect(SUGGESTED_CLAUDE_ROUTINE_PROMPT).toContain('routine-fire-payload');
        expect(SUGGESTED_CLAUDE_ROUTINE_PROMPT).toContain('done_report_claude_ask');
        expect(SUGGESTED_CLAUDE_ROUTINE_PROMPT).toContain('needsInput');
    });
});

describe('describeLoadError', () => {
    it("says the Claude routine couldn't be loaded, or that the server was unreachable", () => {
        expect(describeLoadError(new ClaudeRoutineApiError('x', { status: 500 }))).toBe(CLAUDE_ROUTINE_LOAD_ERROR);
        expect(CLAUDE_ROUTINE_LOAD_ERROR).toBe("Couldn't load your Claude routine.");
        expect(describeLoadError(new ClaudeRoutineApiError('x', { status: 0 }))).toContain("Couldn't reach");
    });
});
