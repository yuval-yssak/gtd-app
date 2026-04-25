import { describe, expect, it } from 'vitest';
import { applyDoneMarker, DONE_PREFIX, stripDoneMarker } from '../lib/doneMarker.js';

describe('applyDoneMarker', () => {
    it('prefixes an unmarked title with "✓ "', () => {
        expect(applyDoneMarker('Verify done sync')).toBe('✓ Verify done sync');
    });

    it('is idempotent — does not double-prefix an already-marked title', () => {
        const once = applyDoneMarker('Verify done sync');
        expect(applyDoneMarker(once)).toBe(once);
    });

    it('handles an empty string by emitting just the prefix', () => {
        expect(applyDoneMarker('')).toBe(DONE_PREFIX);
    });
});

describe('stripDoneMarker', () => {
    it('strips a single leading "✓ " prefix', () => {
        expect(stripDoneMarker('✓ Verify done sync')).toBe('Verify done sync');
    });

    it('is a no-op when the prefix is absent', () => {
        expect(stripDoneMarker('Verify done sync')).toBe('Verify done sync');
    });

    it('strips only one prefix when the title was double-marked', () => {
        // applyDoneMarker is idempotent so this only happens via direct mishandling — guard the
        // inverse to make the contract symmetric: stripDoneMarker peels exactly one prefix.
        expect(stripDoneMarker('✓ ✓ Verify done sync')).toBe('✓ Verify done sync');
    });

    it('returns empty string when input is exactly the prefix', () => {
        expect(stripDoneMarker('✓ ')).toBe('');
    });
});
