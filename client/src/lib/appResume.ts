/**
 * App-resume detection — fires when the app comes back to the foreground after the OS or browser
 * backgrounded it.
 *
 * Exists because an installed iOS PWA has no way to refresh: `display: 'standalone'` removes the
 * browser chrome (no reload button, no pull-to-refresh), and iOS freezes the web view on
 * backgrounding rather than firing `offline`/`online`. The app's other sync triggers — boot, the
 * offline→online transition, and SSE/push events — therefore never fire on resume, leaving the UI
 * on stale IndexedDB until the user force-quits and relaunches. This is that missing trigger.
 *
 * Both `visibilitychange` and `pageshow` are observed: iOS fires them inconsistently across resume
 * paths (app switcher, lock screen, bfcache restore), so we take whichever arrives and collapse
 * duplicates with a short quiet period.
 */

/** Ignores a second resume within this window — one resume commonly fires both events. */
const RESUME_DEDUPE_MS = 1_000;

/**
 * Calls `onResume` when the app returns to the foreground. Returns an unsubscribe function.
 *
 * `now` is injectable so tests can drive the dedupe window without fake timers.
 */
export function subscribeToAppResume(onResume: () => void, now: () => number = Date.now): () => void {
    let lastResumeAt = 0;

    const onForegrounded = () => {
        // `visibilitychange` fires on hide too; only the visible edge is a resume.
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            return;
        }
        const at = now();
        if (at - lastResumeAt < RESUME_DEDUPE_MS) {
            return;
        }
        lastResumeAt = at;
        onResume();
    };

    // Guarded for the node-env test runner, matching lib/dayClock.ts.
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onForegrounded);
    }
    // `pageshow` also fires once on an ordinary cold load (not just a bfcache restore), so boot
    // emits one resume alongside its own sync. That is deliberately not filtered on `persisted`:
    // the duplicate is absorbed by syncAndRefresh's in-flight guard, and treating every pageshow
    // as a resume avoids depending on how a given iOS version reports a restore.
    if (typeof window !== 'undefined') {
        window.addEventListener('pageshow', onForegrounded);
    }

    return () => {
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onForegrounded);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('pageshow', onForegrounded);
        }
    };
}
