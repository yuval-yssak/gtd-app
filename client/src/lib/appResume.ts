import dayjs from 'dayjs';

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
 * Away at least this long, the data on screen is no longer taken as checked with the server: a
 * frozen PWA's live channel was dead the whole time. Shorter switches (another tab, a quick reply
 * elsewhere) keep their verification, so the badge does not blink on every return.
 */
export const LONG_AWAY_MS = 5 * 60_000;

// Module state so the e2e harness can shrink it (devTools `setLongAwayMs`) and background a page for
// real seconds instead of faking the clock, which stalls the app's own timers.
const longAway = { ms: LONG_AWAY_MS };

/** Test/harness-only: override the long-absence threshold. */
export function setLongAwayMs(ms: number): void {
    longAway.ms = ms;
}

/** What a resume knows: how long the app was hidden, or null when it never saw it hide (a page load). */
export interface AppResume {
    awayMs: number | null;
}

export function isAwayLongEnoughToDoubtData(awayMs: number | null): boolean {
    return awayMs !== null && awayMs >= longAway.ms;
}

/**
 * Calls `onResume` when the app returns to the foreground. Returns an unsubscribe function.
 *
 * `now` is injectable so tests can drive the dedupe window without fake timers.
 */
export function subscribeToAppResume(onResume: (resume: AppResume) => void, now: () => number = () => dayjs().valueOf()): () => void {
    let lastResumeAt = 0;
    // When the app was last seen going to the background; consumed by the next resume.
    let hiddenAt: number | null = null;

    const onBackgrounded = (event: Event) => {
        // `visibilitychange` fires on show too; only the hidden edge (or a pagehide) starts the clock.
        if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') {
            return;
        }
        // Restarted on every hide: a resume swallowed by the dedupe window must not stretch the next absence.
        hiddenAt = now();
    };

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
        const awayMs = hiddenAt === null ? null : at - hiddenAt;
        hiddenAt = null;
        onResume({ awayMs });
    };

    // Guarded for the node-env test runner, matching lib/dayClock.ts.
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onBackgrounded);
        document.addEventListener('visibilitychange', onForegrounded);
    }
    // `pageshow` also fires once on an ordinary cold load (not just a bfcache restore), so boot
    // emits one resume alongside its own sync. That is deliberately not filtered on `persisted`:
    // the duplicate is absorbed by syncAndRefresh's in-flight guard, and treating every pageshow
    // as a resume avoids depending on how a given iOS version reports a restore.
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', onBackgrounded);
        window.addEventListener('pageshow', onForegrounded);
    }

    return () => {
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onBackgrounded);
            document.removeEventListener('visibilitychange', onForegrounded);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('pagehide', onBackgrounded);
            window.removeEventListener('pageshow', onForegrounded);
        }
    };
}
