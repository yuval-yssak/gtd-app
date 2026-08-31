import dayjs from 'dayjs';

/**
 * App-wide day clock — the single source of "today" (local calendar date, YYYY-MM-DD) for every
 * tickler/overdue filter. Exactly ONE timer serves the whole app: it fires just past the next
 * local midnight, rolls the day, notifies subscribers, and re-arms itself indefinitely — so a tab
 * left open for days reveals each day's tickler items at local midnight with no reload.
 *
 * The timer targets the next local midnight rather than a fixed 24h interval, so DST shifts and
 * manual clock changes never drift it. Browsers throttle/coalesce background-tab timers, so
 * `visibilitychange`/`focus` wake-ups re-check the date and re-arm the timer as a missed-fire
 * guard.
 */

// Module-level mutable state is the point of this module: one shared clock, not one per consumer.
let todayIso = dayjs().format('YYYY-MM-DD');
let midnightTimer: ReturnType<typeof setTimeout> | undefined;
let isStarted = false;
const listeners = new Set<() => void>();

/** Cached snapshot — safe as a `useSyncExternalStore` getSnapshot (only changes with a notify). */
export function getTodayIso(): string {
    return todayIso;
}

/** Subscribe to local-midnight day changes. The first subscriber arms the clock; it stays armed
 *  after the last unsubscribe (one timer for the tab's lifetime — cheaper than re-arming on every
 *  route change, and the snapshot must stay warm for the next subscriber). */
export function subscribeToDayChange(onDayChanged: () => void): () => void {
    startDayClockOnce();
    listeners.add(onDayChanged);
    return () => listeners.delete(onDayChanged);
}

function startDayClockOnce(): void {
    if (isStarted) {
        return;
    }
    isStarted = true;
    // The snapshot was seeded at module eval; the first subscriber can mount much later (this
    // module loads at page load, while _authenticated Suspends on app data). Re-derive before
    // arming so a midnight crossed in that gap isn't absorbed for a whole day.
    checkDayBoundaryAndRearm();
    // Guarded for the node-env test runner — the timer still works there, only the wake-up
    // listeners need a DOM.
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', checkDayBoundaryAndRearm);
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('focus', checkDayBoundaryAndRearm);
    }
}

function armMidnightTimer(): void {
    clearTimeout(midnightTimer);
    // +1s past midnight so a timer the browser fires marginally early still lands on the new day.
    // If it fires early anyway, the check no-ops and the immediate re-arm — computed from the
    // still-old day — lands 1s past the actual midnight, so the roll is only ever delayed, not lost.
    const msUntilJustPastMidnight = dayjs().add(1, 'day').startOf('day').diff(dayjs()) + 1000;
    midnightTimer = setTimeout(checkDayBoundaryAndRearm, msUntilJustPastMidnight);
}

function checkDayBoundaryAndRearm(): void {
    rollDayIfChanged();
    armMidnightTimer();
}

function rollDayIfChanged(): void {
    const currentDay = dayjs().format('YYYY-MM-DD');
    if (currentDay === todayIso) {
        return;
    }
    todayIso = currentDay;
    for (const notify of listeners) {
        notify();
    }
}

/** Test-only: tear the singleton down so fake-timer tests re-arm it from a known state. */
export function __resetDayClockForTests(): void {
    clearTimeout(midnightTimer);
    midnightTimer = undefined;
    isStarted = false;
    listeners.clear();
    if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', checkDayBoundaryAndRearm);
    }
    if (typeof window !== 'undefined') {
        window.removeEventListener('focus', checkDayBoundaryAndRearm);
    }
    todayIso = dayjs().format('YYYY-MM-DD');
}
