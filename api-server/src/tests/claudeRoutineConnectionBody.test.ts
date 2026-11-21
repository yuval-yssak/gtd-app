import { describe, expect, it } from 'vitest';
import { assertClaudeRoutineFakeNotInProduction } from '../config.js';
import { parseConnectionBody, presentConnection } from '../lib/claudeRoutine/claudeRoutineConnection.js';
import { parseClaudeAskReport } from '../routes/v1/claudeAsks.js';

const TOKEN = 'sk-ant-oat01-abcdefghijklmnop';

describe('parseConnectionBody', () => {
    it('accepts and trims a trig_ id and an sk-ant-oat01 token', () => {
        expect(parseConnectionBody({ claudeRoutineId: ' trig_01ABC ', token: ` ${TOKEN} ` })).toEqual({
            ok: true,
            input: { claudeRoutineId: 'trig_01ABC', token: TOKEN },
        });
    });

    it.each([
        [{ claudeRoutineId: 'routine_1', token: TOKEN }, 'invalid_claude_routine_id'],
        [{ token: TOKEN }, 'invalid_claude_routine_id'],
        [{ claudeRoutineId: 'trig_1', token: 'sk-ant-api03-abcdefghijklmnop' }, 'invalid_claude_routine_token'],
        [{ claudeRoutineId: 'trig_1' }, 'invalid_claude_routine_token'],
        [null, 'invalid_claude_routine_id'],
    ])('rejects %j with %s', (body, code) => {
        expect(parseConnectionBody(body)).toMatchObject({ ok: false, code });
    });
});

describe('presentConnection', () => {
    it('never exposes the encrypted token', () => {
        const view = presentConnection({
            _id: 'u',
            user: 'u',
            claudeRoutineId: 'trig_1',
            tokenEncrypted: 'secret',
            tokenHint: 'mnop',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-02T00:00:00.000Z',
        });
        expect(view).toEqual({ connected: true, claudeRoutineId: 'trig_1', tokenHint: 'mnop', updatedTs: '2026-01-02T00:00:00.000Z' });
        expect(presentConnection(null)).toEqual({ connected: false });
    });
});

describe('parseClaudeAskReport', () => {
    it('defaults the outcome to completed and trims the summary', () => {
        expect(parseClaudeAskReport({ summary: ' Renamed the item ' })).toEqual({ ok: true, report: { summary: 'Renamed the item', outcome: 'completed' } });
    });

    it('accepts needsInput', () => {
        expect(parseClaudeAskReport({ summary: 'Which ticket?', outcome: 'needsInput' })).toMatchObject({ ok: true, report: { outcome: 'needsInput' } });
    });

    it.each([[{ summary: '' }], [{ summary: 'x'.repeat(281) }], [{ summary: 'ok', outcome: 'failed' }], [null]])('rejects %j', (body) => {
        expect(parseClaudeAskReport(body)).toMatchObject({ ok: false });
    });
});

describe('assertClaudeRoutineFakeNotInProduction', () => {
    it('throws only when the fake flag is set under NODE_ENV=production', () => {
        expect(() => assertClaudeRoutineFakeNotInProduction({ NODE_ENV: 'production', CLAUDE_ROUTINE_FAKE: '1' })).toThrow(/test-only/);
        expect(() => assertClaudeRoutineFakeNotInProduction({ NODE_ENV: 'production' })).not.toThrow();
        expect(() => assertClaudeRoutineFakeNotInProduction({ NODE_ENV: 'development', CLAUDE_ROUTINE_FAKE: '1' })).not.toThrow();
    });
});
