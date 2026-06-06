import Anthropic from '@anthropic-ai/sdk';

/**
 * Lazily-constructed singleton Anthropic client. Lazy so the server boots without an API key
 * (the key is only needed when the Claude-assist endpoint is actually hit), and so tests can
 * mock this one module (`vi.mock('.../anthropicClient.js')`) instead of the whole SDK.
 *
 * `maxRetries` is intentionally low: this backs a latency-sensitive ~5–15s endpoint where a long
 * retry storm is worse than a fast failure the user can re-trigger.
 */
let client: Anthropic | undefined;

export function getAnthropicClient(): Anthropic {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('ANTHROPIC_API_KEY is not configured');
        }
        client = new Anthropic({ apiKey, maxRetries: 1 });
    }
    return client;
}

/** The model backing Lane A. Sonnet 4.6 balances quality and the per-call cost/latency budget. */
export const CLAUDE_ASSIST_MODEL = 'claude-sonnet-4-6';
