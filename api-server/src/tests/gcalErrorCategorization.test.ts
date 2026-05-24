import { describe, expect, it } from 'vitest';
import { categorizeGCalError } from '../lib/gcalErrorCategorization.js';

/** Convenience: build a Gaxios-shaped error with the given numeric code. */
function gcalErr(code: number, message = 'gcal'): Error & { code: number } {
    return Object.assign(new Error(message), { code });
}

describe('categorizeGCalError', () => {
    it('classifies invalid_grant as scope_missing', () => {
        expect(categorizeGCalError(new Error('invalid_grant'))).toBe('scope_missing');
    });

    it('classifies 404 and 410 as terminal (event gone)', () => {
        expect(categorizeGCalError(gcalErr(404))).toBe('terminal');
        expect(categorizeGCalError(gcalErr(410))).toBe('terminal');
    });

    it('classifies 403 as terminal (attendee mutation rejected)', () => {
        expect(categorizeGCalError(gcalErr(403))).toBe('terminal');
    });

    it('classifies 409 as edit_conflict', () => {
        expect(categorizeGCalError(gcalErr(409))).toBe('edit_conflict');
    });

    it('classifies 5xx and 429 as transient_exhausted (retried first, then categorized)', () => {
        expect(categorizeGCalError(gcalErr(500))).toBe('transient_exhausted');
        expect(categorizeGCalError(gcalErr(503))).toBe('transient_exhausted');
        expect(categorizeGCalError(gcalErr(429))).toBe('transient_exhausted');
    });

    it('falls back to transient_exhausted for unknown errors (safe default)', () => {
        // A non-Gaxios error without invalid_grant — bucket as transient so the SyncIssuesPanel
        // still offers Retry rather than Dismiss-forever.
        expect(categorizeGCalError(new Error('network timeout'))).toBe('transient_exhausted');
        expect(categorizeGCalError(undefined)).toBe('transient_exhausted');
        expect(categorizeGCalError('plain string')).toBe('transient_exhausted');
    });

    it('classifies an unknown numeric code as transient_exhausted', () => {
        // Some 4xx code we did not call out explicitly — Retry is the safer guess than Dismiss.
        expect(categorizeGCalError(gcalErr(418))).toBe('transient_exhausted');
    });
});
