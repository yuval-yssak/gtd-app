import { describe, expect, it } from 'vitest';
import { describeDevice } from '../lib/deviceLabel';

// Real-world UA strings (trimmed to the discriminating parts).
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

describe('describeDevice', () => {
    it('labels Chrome on macOS', () => {
        expect(describeDevice(CHROME_MAC)).toBe('Chrome on macOS');
    });

    it('labels Edge on Windows (Edge outranks the embedded Chrome token)', () => {
        expect(describeDevice(EDGE_WINDOWS)).toBe('Edge on Windows');
    });

    it('labels Firefox on Linux', () => {
        expect(describeDevice(FIREFOX_LINUX)).toBe('Firefox on Linux');
    });

    it('labels Safari on iOS', () => {
        expect(describeDevice(SAFARI_IPHONE)).toBe('Safari on iOS');
    });

    it('labels Chrome on Android (Android outranks the embedded Linux token)', () => {
        expect(describeDevice(CHROME_ANDROID)).toBe('Chrome on Android');
    });

    it('labels Chrome on iOS via the CriOS token', () => {
        expect(describeDevice(CHROME_IOS)).toBe('Chrome on iOS');
    });

    it('labels Safari on macOS (no Chrome token present)', () => {
        expect(describeDevice(SAFARI_MAC)).toBe('Safari on macOS');
    });

    it('falls back to the recognized half when only one side matches', () => {
        expect(describeDevice('SomethingNew/1.0 (Windows NT 10.0)')).toBe('Windows');
        expect(describeDevice('Mozilla/5.0 (FutureOS) Firefox/127.0')).toBe('Firefox');
    });

    it('degrades to a generic label for an unrecognizable UA', () => {
        expect(describeDevice('curl/8.0')).toBe('Unknown device');
    });
});
