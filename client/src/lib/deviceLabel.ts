/**
 * Derives a human-readable device label ("Chrome on macOS") from a user-agent string. Sent with
 * /sync/bootstrap so the connected-devices list in Settings can show something friendlier than a
 * UUID. Best-effort by design — an unrecognized UA degrades to a partial or generic label.
 */

// Order matters: Edge/Opera UAs contain "Chrome", and Chrome UAs contain "Safari".
const BROWSER_MATCHERS: [RegExp, string][] = [
    [/edg(a|ios)?\//i, 'Edge'],
    [/opr\//i, 'Opera'],
    [/firefox\/|fxios\//i, 'Firefox'],
    [/crios\//i, 'Chrome'],
    [/chrome\//i, 'Chrome'],
    [/safari\//i, 'Safari'],
];

// Android before Linux (Android UAs contain "Linux"). iPadOS 13+ Safari reports "Macintosh",
// so iPads label as macOS — acceptable for a display-only string.
const PLATFORM_MATCHERS: [RegExp, string][] = [
    [/android/i, 'Android'],
    [/iphone|ipad|ipod/i, 'iOS'],
    [/mac os x|macintosh/i, 'macOS'],
    [/windows/i, 'Windows'],
    [/cros/i, 'ChromeOS'],
    [/linux/i, 'Linux'],
];

function firstMatch(matchers: [RegExp, string][], userAgent: string): string | undefined {
    return matchers.find(([pattern]) => pattern.test(userAgent))?.[1];
}

export function describeDevice(userAgent: string): string {
    const browser = firstMatch(BROWSER_MATCHERS, userAgent);
    const platform = firstMatch(PLATFORM_MATCHERS, userAgent);
    if (browser && platform) {
        return `${browser} on ${platform}`;
    }
    return browser ?? platform ?? 'Unknown device';
}
