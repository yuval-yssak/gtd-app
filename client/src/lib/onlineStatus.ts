/**
 * `true` only when the browser affirmatively reports offline. `navigator.onLine` is undefined in
 * non-browser environments (Node vitest runs), and undefined must count as online — otherwise every
 * unit test would take the offline branch.
 */
export function isBrowserOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}
