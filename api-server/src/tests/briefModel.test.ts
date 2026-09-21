/** generateBriefText (lib/brief/briefModel.ts) with the Anthropic client mocked at the seam, plus
 * the error → HTTP mapping, the ≤ 160-char fit rule, the fake seam and its production guard. */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBriefFakeModelNotInProduction } from '../config.js';
import { BriefGenerationError, briefErrorToHttp, fitBriefText, generateBriefText } from '../lib/brief/briefModel.js';
import { BRIEF_MODEL } from '../lib/brief/briefPrompt.js';

const messagesCreate = vi.fn();
vi.mock('../lib/claude/anthropicClient.js', () => ({
    getAnthropicClient: () => {
        if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
        return { messages: { create: messagesCreate } };
    },
}));

const LONG_NOTES = 'Expires in March; need photos and the old passport. The consulate only takes appointments on weekday mornings. Book early.';
const ITEM = { title: 'Renew passport', notes: LONG_NOTES, status: 'nextAction' as const };

function modelReply(text: string, stop_reason = 'end_turn') {
    return { stop_reason, content: [{ type: 'text', text }] };
}

afterEach(() => {
    vi.unstubAllEnvs();
    messagesCreate.mockReset();
});

describe('generateBriefText', () => {
    it('parses { brief } from the text block and stamps the model id', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'k');
        messagesCreate.mockResolvedValue(modelReply(JSON.stringify({ brief: 'Passport renewal still blocked on photos.' })));
        await expect(generateBriefText(ITEM)).resolves.toEqual({ text: 'Passport renewal still blocked on photos.', model: BRIEF_MODEL });
        expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({ model: BRIEF_MODEL, max_tokens: 256 }));
    });

    it('returns a null brief when the model says the title already covers it', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'k');
        messagesCreate.mockResolvedValue(modelReply(JSON.stringify({ brief: null })));
        await expect(generateBriefText(ITEM)).resolves.toEqual({ text: null, model: BRIEF_MODEL });
    });

    it('truncates an overlong brief at the last word boundary within 160 chars and appends an ellipsis', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'k');
        const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
        messagesCreate.mockResolvedValue(modelReply(JSON.stringify({ brief: words })));
        const { text } = await generateBriefText(ITEM);
        if (text === null) throw new Error('expected text');
        expect(text.length).toBeLessThanOrEqual(160);
        expect(text.endsWith('…')).toBe(true);
        expect(text.slice(0, -1)).toMatch(/word\d+$/);
        expect(words.startsWith(text.slice(0, -1))).toBe(true);
    });

    it('throws a refusal BriefGenerationError on stop_reason refusal', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'k');
        messagesCreate.mockResolvedValue({ stop_reason: 'refusal', content: [] });
        await expect(generateBriefText(ITEM)).rejects.toMatchObject({ name: 'BriefGenerationError', code: 'refusal' });
    });

    it('throws malformed_output on unparseable JSON, a missing text block, or a wrong shape', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'k');
        messagesCreate.mockResolvedValueOnce(modelReply('not json'));
        await expect(generateBriefText(ITEM)).rejects.toMatchObject({ code: 'malformed_output' });
        messagesCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });
        await expect(generateBriefText(ITEM)).rejects.toMatchObject({ code: 'malformed_output' });
        messagesCreate.mockResolvedValueOnce(modelReply(JSON.stringify({ brief: 42 })));
        await expect(generateBriefText(ITEM)).rejects.toMatchObject({ code: 'malformed_output' });
    });

    it('maps a missing API key to 503 agent_unavailable', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        const err = await generateBriefText(ITEM).catch((e: unknown) => e);
        expect(briefErrorToHttp(err)).toMatchObject({ status: 503, code: 'agent_unavailable' });
        expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('fake seam: returns "[fake] <first sentence>" and never touches the SDK', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        vi.stubEnv('BRIEF_FAKE_MODEL', '1');
        await expect(generateBriefText(ITEM)).resolves.toEqual({ text: '[fake] Expires in March; need photos and the old passport', model: 'fake' });
        await expect(generateBriefText({ ...ITEM, notes: 'Call Dana!\nThen book.' })).resolves.toEqual({ text: '[fake] Call Dana', model: 'fake' });
        await expect(generateBriefText({ ...ITEM, notes: '   ' })).resolves.toEqual({ text: null, model: 'fake' });
        const giant = 'a'.repeat(400);
        const { text } = await generateBriefText({ ...ITEM, notes: giant });
        expect(text).toBe(`[fake] ${'a'.repeat(150)}`);
        expect(messagesCreate).not.toHaveBeenCalled();
    });
});

describe('fitBriefText', () => {
    it('trims, collapses empty to null, and leaves ≤ 160 chars untouched', () => {
        expect(fitBriefText('  hello  ')).toBe('hello');
        expect(fitBriefText('')).toBeNull();
        expect(fitBriefText('   ')).toBeNull();
        expect(fitBriefText(null)).toBeNull();
        expect(fitBriefText('x'.repeat(160))).toBe('x'.repeat(160));
    });

    it('cuts at a word boundary sitting right at the window edge', () => {
        // 159 chars, a space, then more: the space at index 159 is the last inside the 160 window.
        const fitted = fitBriefText(`${'a'.repeat(159)} tail words`);
        expect(fitted).toBe(`${'a'.repeat(159)}…`);
        // Exactly 161 chars with the space at index 160 (outside the window): cut at the earlier boundary.
        const edge = fitBriefText(`${'b'.repeat(100)} ${'c'.repeat(59)} d`);
        expect(edge).toBe(`${'b'.repeat(100)}…`);
    });

    it('hard-cuts a single 200-char token to 159 chars + ellipsis when no word boundary exists', () => {
        const fitted = fitBriefText('y'.repeat(200));
        expect(fitted).toBe(`${'y'.repeat(159)}…`);
    });
});

describe('briefErrorToHttp', () => {
    it('passes an Anthropic 429 through as 429 rate_limited with Retry-After', () => {
        const err = new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers({ 'retry-after': '17' }));
        expect(briefErrorToHttp(err)).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSec: 17 });
        const noHeader = new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers());
        expect(briefErrorToHttp(noHeader).retryAfterSec).toBeUndefined();
    });

    it('maps refusal / malformed output / unknown errors to 502 brief_generation_failed', () => {
        expect(briefErrorToHttp(new BriefGenerationError('refusal', 'no'))).toMatchObject({
            status: 502,
            code: 'brief_generation_failed',
            logLine: 'refusal: no',
        });
        expect(briefErrorToHttp(new Error('boom'))).toMatchObject({ status: 502, code: 'brief_generation_failed' });
    });

    it('maps an Anthropic 5xx / overloaded to 503 agent_unavailable', () => {
        const err = new Anthropic.InternalServerError(529, { type: 'error' }, 'overloaded', new Headers());
        expect(briefErrorToHttp(err)).toMatchObject({ status: 503, code: 'agent_unavailable' });
    });
});

describe('assertBriefFakeModelNotInProduction', () => {
    it('throws only when the fake flag is set under NODE_ENV=production', () => {
        expect(() => assertBriefFakeModelNotInProduction({ NODE_ENV: 'production', BRIEF_FAKE_MODEL: '1' })).toThrow(/test-only/);
        expect(() => assertBriefFakeModelNotInProduction({ NODE_ENV: 'production' })).not.toThrow();
        expect(() => assertBriefFakeModelNotInProduction({ NODE_ENV: 'development', BRIEF_FAKE_MODEL: '1' })).not.toThrow();
    });
});
