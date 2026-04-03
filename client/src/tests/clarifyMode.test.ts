import { describe, expect, it } from 'vitest';
import { CLARIFY_MODES, parseClarifyMode } from '../lib/clarifyMode';

describe('parseClarifyMode', () => {
    it('returns a valid mode unchanged', () => {
        for (const mode of CLARIFY_MODES) {
            expect(parseClarifyMode(mode)).toBe(mode);
        }
    });

    it('returns dialog for an unknown string', () => {
        expect(parseClarifyMode('bogus')).toBe('dialog');
    });

    it('returns dialog for null', () => {
        expect(parseClarifyMode(null)).toBe('dialog');
    });
});
