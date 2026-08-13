import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBrowserOffline } from '../lib/onlineStatus';

afterEach(() => {
    vi.unstubAllGlobals();
});

// The undefined-handling here is the whole reason the probe exists (Node test envs have no
// navigator.onLine) — these tests pin it against a well-meaning refactor to `!navigator.onLine`.
describe('isBrowserOffline', () => {
    it('treats an absent navigator as online so Node test runs never take the offline branch', () => {
        vi.stubGlobal('navigator', undefined);
        expect(isBrowserOffline()).toBe(false);
    });

    it('treats an undefined navigator.onLine as online', () => {
        vi.stubGlobal('navigator', {});
        expect(isBrowserOffline()).toBe(false);
    });

    it('reports offline only when navigator.onLine is explicitly false', () => {
        vi.stubGlobal('navigator', { onLine: false });
        expect(isBrowserOffline()).toBe(true);
    });

    it('reports online when navigator.onLine is true', () => {
        vi.stubGlobal('navigator', { onLine: true });
        expect(isBrowserOffline()).toBe(false);
    });
});
