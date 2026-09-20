import Anthropic from '@anthropic-ai/sdk';
import { classifyAgentError } from '../claude/agentError.js';
import { getAnthropicClient } from '../claude/anthropicClient.js';
import { BRIEF_TARGET_MAX_CHARS, type BriefSourceItem, buildBriefRequest } from './briefPrompt.js';

export interface GeneratedBrief {
    /** The one-line brief, or `null` when the model judged the title already says it all. */
    text: string | null;
    /** Model id that produced it (`'fake'` under the test seam). */
    model: string;
}

export type BriefGenerationErrorCode = 'refusal' | 'malformed_output';

/** The model answered but not with a usable brief (refused, or emitted something we cannot parse). */
export class BriefGenerationError extends Error {
    readonly code: BriefGenerationErrorCode;
    constructor(code: BriefGenerationErrorCode, message: string) {
        super(message);
        this.name = 'BriefGenerationError';
        this.code = code;
    }
}

const FAKE_MODEL = 'fake';
const FAKE_FIRST_SENTENCE_MAX_CHARS = 150;

/** Text up to the first sentence terminator or newline, trimmed and capped; `null` for empty notes. */
function firstSentence(notes: string | undefined): string | null {
    const trimmed = (notes ?? '').trim();
    if (trimmed.length === 0) {
        return null;
    }
    const [head = ''] = trimmed.split(/[.!?\n]/, 1);
    return head.trim().slice(0, FAKE_FIRST_SENTENCE_MAX_CHARS);
}

/** Deterministic stand-in for e2e (`BRIEF_FAKE_MODEL=1`); production refuses to boot with the flag set (config.ts). */
function fakeBrief(item: BriefSourceItem): GeneratedBrief {
    const sentence = firstSentence(item.notes);
    return { text: sentence === null ? null : `[fake] ${sentence}`, model: FAKE_MODEL };
}

/**
 * Enforces the ≤ 160-character contract regardless of what the model returned: trims, and
 * truncates an overlong sentence at the last word boundary that fits, appending an ellipsis.
 * Empty-after-trim collapses to `null` (same meaning as the model's explicit null).
 */
export function fitBriefText(raw: string | null): string | null {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (trimmed.length <= BRIEF_TARGET_MAX_CHARS) {
        return trimmed;
    }
    const window = trimmed.slice(0, BRIEF_TARGET_MAX_CHARS);
    const lastSpace = window.lastIndexOf(' ');
    // No word boundary inside the window (one giant token) — cut hard rather than return nothing.
    const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window.slice(0, BRIEF_TARGET_MAX_CHARS - 1);
    return `${cut.trimEnd()}…`;
}

function parseBriefOutput(response: Anthropic.Message): string | null {
    if (response.stop_reason === 'refusal') {
        throw new BriefGenerationError('refusal', 'the model refused to produce a brief');
    }
    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
    if (!textBlock) {
        throw new BriefGenerationError('malformed_output', `no text block in the response (stop_reason=${response.stop_reason})`);
    }
    return parseBriefJson(textBlock.text);
}

function parseBriefJson(text: string): string | null {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('brief' in parsed)) {
        throw new BriefGenerationError('malformed_output', 'response JSON is not { brief }');
    }
    const { brief } = parsed;
    if (brief !== null && typeof brief !== 'string') {
        throw new BriefGenerationError('malformed_output', 'brief must be a string or null');
    }
    return brief;
}

/** One direct `messages.create` call; the request itself comes from the shared pure builder. */
export async function generateBriefText(item: BriefSourceItem): Promise<GeneratedBrief> {
    if (process.env.BRIEF_FAKE_MODEL === '1') {
        return fakeBrief(item);
    }
    const request = buildBriefRequest(item);
    const response = await getAnthropicClient().messages.create(request);
    try {
        return { text: fitBriefText(parseBriefOutput(response)), model: request.model };
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new BriefGenerationError('malformed_output', `response text is not JSON: ${err.message}`);
        }
        throw err;
    }
}

export interface BriefHttpError {
    status: 429 | 502 | 503;
    code: 'rate_limited' | 'brief_generation_failed' | 'agent_unavailable';
    message: string;
    /** Seconds, passed through from Anthropic's `retry-after` when it sent one. */
    retryAfterSec?: number;
    /** Operator-facing detail for the server log. */
    logLine: string;
}

function retryAfterSeconds(headers: Headers): number | undefined {
    const raw = Number(headers.get('retry-after'));
    return Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : undefined;
}

/**
 * Maps a generation failure to an HTTP response. Anthropic-side outages (missing key, out of
 * credits, 5xx) reuse `classifyAgentError`'s 503 `agent_unavailable`; an Anthropic 429 is
 * surfaced as our own 429 with its Retry-After so a client backs off instead of hammering;
 * everything else (refusal, malformed output, a bad request we built) is 502.
 */
export function briefErrorToHttp(err: unknown): BriefHttpError {
    if (err instanceof Anthropic.RateLimitError) {
        const retryAfterSec = retryAfterSeconds(err.headers);
        return {
            status: 429,
            code: 'rate_limited',
            message: 'Brief generation is rate-limited upstream. Please retry shortly.',
            ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
            logLine: `Anthropic rate limit (request_id=${err.requestID ?? 'unknown'}): ${err.message}`,
        };
    }
    const classified = classifyAgentError(err);
    if (classified.status === 503) {
        return { status: 503, code: 'agent_unavailable', message: classified.message, logLine: classified.logLine };
    }
    const detail = err instanceof BriefGenerationError ? `${err.code}: ${err.message}` : classified.logLine;
    return { status: 502, code: 'brief_generation_failed', message: 'Could not generate a brief for this item.', logLine: detail };
}
