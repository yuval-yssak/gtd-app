/**
 * The shared day clock: one self-rescheduling timer that rolls `todayIso` at each local midnight,
 * indefinitely, plus wake-up rechecks for throttled background tabs. Pins the GTD item's
 * constraints: a single app-wide timer, day-to-day self-rescheduling, and next-midnight targeting.
 */
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDayClockForTests, getTodayIso, subscribeToDayChange } from '../lib/dayClock';

// The node test env has no document/window — provide EventTarget stubs so the wake-up listener
// wiring (visibilitychange/focus) is exercised rather than skipped.
function installDomEventTargetStub(globalName: 'document' | 'window'): EventTarget {
    const stub = new EventTarget();
    Object.defineProperty(globalThis, globalName, { value: stub, configurable: true, writable: true });
    return stub;
}
const documentStub = installDomEventTargetStub('document');
const windowStub = installDomEventTargetStub('window');

/** Local wall-clock instant on a fixed date, parsed in the test process's timezone. */
const localTime = (isoLocal: string) => dayjs(isoLocal).toDate();

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(localTime('2026-08-29T23:59:00'));
    __resetDayClockForTests();
});

afterEach(() => {
    __resetDayClockForTests();
    vi.useRealTimers();
});

describe('dayClock', () => {
    it('rolls the day and notifies subscribers when the timer crosses local midnight', () => {
        const onDayChanged = vi.fn();
        subscribeToDayChange(onDayChanged);
        expect(getTodayIso()).toBe('2026-08-29');

        vi.advanceTimersByTime(2 * 60 * 1000);

        expect(getTodayIso()).toBe('2026-08-30');
        expect(onDayChanged).toHaveBeenCalledTimes(1);
    });

    it('keeps rolling across several consecutive midnights (self-rescheduling)', () => {
        const onDayChanged = vi.fn();
        subscribeToDayChange(onDayChanged);

        vi.advanceTimersByTime(2 * 60 * 1000);
        expect(getTodayIso()).toBe('2026-08-30');
        vi.advanceTimersByTime(24 * 60 * 60 * 1000);
        expect(getTodayIso()).toBe('2026-08-31');
        vi.advanceTimersByTime(24 * 60 * 60 * 1000);
        expect(getTodayIso()).toBe('2026-09-01');
        expect(onDayChanged).toHaveBeenCalledTimes(3);
    });

    it('holds exactly one timer no matter how many components subscribe', () => {
        subscribeToDayChange(vi.fn());
        subscribeToDayChange(vi.fn());
        subscribeToDayChange(vi.fn());
        expect(vi.getTimerCount()).toBe(1);
    });

    it('re-derives the day when the first subscriber arrives after a midnight the module never saw', () => {
        // The snapshot was seeded at 23:59 (beforeEach reset); the app finishes booting after
        // midnight — e.g. a slow bootstrap Suspending _authenticated across the boundary. The
        // first subscribe must re-derive, not serve yesterday for a whole day.
        vi.setSystemTime(localTime('2026-08-30T00:30:00'));
        subscribeToDayChange(vi.fn());
        expect(getTodayIso()).toBe('2026-08-30');
    });

    it('targets the next local midnight, not a fixed 24h interval', () => {
        // Armed mid-morning: a fixed-24h timer would fire at 09:00 tomorrow and miss midnight.
        vi.setSystemTime(localTime('2026-08-29T09:00:00'));
        __resetDayClockForTests();
        const onDayChanged = vi.fn();
        subscribeToDayChange(onDayChanged);

        vi.advanceTimersByTime(14 * 60 * 60 * 1000); // 23:00 — still today
        expect(getTodayIso()).toBe('2026-08-29');
        expect(onDayChanged).not.toHaveBeenCalled();

        vi.advanceTimersByTime(60 * 60 * 1000 + 2000); // just past midnight
        expect(getTodayIso()).toBe('2026-08-30');
        expect(onDayChanged).toHaveBeenCalledTimes(1);
    });

    it('does not notify before midnight', () => {
        const onDayChanged = vi.fn();
        subscribeToDayChange(onDayChanged);
        vi.advanceTimersByTime(30 * 1000);
        expect(getTodayIso()).toBe('2026-08-29');
        expect(onDayChanged).not.toHaveBeenCalled();
    });

    it('a visibilitychange wake-up catches a midnight the throttled timer missed', () => {
        const onDayChanged = vi.fn();
        subscribeToDayChange(onDayChanged);

        // Jump the wall clock past midnight WITHOUT firing timers — a backgrounded tab whose
        // timer the browser coalesced away.
        vi.setSystemTime(localTime('2026-08-30T09:00:00'));
        documentStub.dispatchEvent(new Event('visibilitychange'));

        expect(getTodayIso()).toBe('2026-08-30');
        expect(onDayChanged).toHaveBeenCalledTimes(1);
        // The wake-up also re-armed the timer for the NEXT midnight — still exactly one.
        expect(vi.getTimerCount()).toBe(1);
    });

    it('a window focus wake-up rechecks the day too', () => {
        const onDayChanged = vi.fn();
        subscribeToDayChange(onDayChanged);

        vi.setSystemTime(localTime('2026-08-30T09:00:00'));
        windowStub.dispatchEvent(new Event('focus'));

        expect(getTodayIso()).toBe('2026-08-30');
        expect(onDayChanged).toHaveBeenCalledTimes(1);
    });

    it('a backward clock jump rolls the day BACK on the next wake-up', () => {
        // Westward travel or an OS clock fix: the wall clock lands before a midnight the clock
        // already rolled past. rollDayIfChanged compares by inequality, not ordering — pin that a
        // backward jump re-derives yesterday instead of serving tomorrow until the clock catches up.
        const onDayChanged = vi.fn();
        subscribeToDayChange(onDayChanged);
        vi.advanceTimersByTime(2 * 60 * 1000); // cross midnight forward first
        expect(getTodayIso()).toBe('2026-08-30');

        vi.setSystemTime(localTime('2026-08-29T21:00:00'));
        windowStub.dispatchEvent(new Event('focus'));

        expect(getTodayIso()).toBe('2026-08-29');
        expect(onDayChanged).toHaveBeenCalledTimes(2);
        // The wake-up re-armed against the (again-upcoming) midnight — still exactly one timer.
        expect(vi.getTimerCount()).toBe(1);

        // Forward recovery: the re-armed timer targets the NEW next midnight (3h away), not a
        // stale offset — one timer existing proves nothing about where it points.
        vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 5000);
        expect(getTodayIso()).toBe('2026-08-30');
        expect(onDayChanged).toHaveBeenCalledTimes(3);
    });

    it('a wake-up with no day change re-arms without leaking timers', () => {
        // Pins the clearTimeout in armMidnightTimer on the no-roll path — repeated tab
        // foregrounding within one day must not accumulate parallel midnight timers.
        subscribeToDayChange(vi.fn());
        documentStub.dispatchEvent(new Event('visibilitychange'));
        documentStub.dispatchEvent(new Event('visibilitychange'));
        expect(vi.getTimerCount()).toBe(1);
    });

    it('the clock stays armed after the last unsubscribe and keeps the snapshot warm', () => {
        // The documented lifetime contract: unsubscribing everyone does NOT tear the timer down,
        // so the next subscriber (e.g. after a route change) reads a current snapshot.
        const unsubscribe = subscribeToDayChange(vi.fn());
        unsubscribe();

        vi.advanceTimersByTime(2 * 60 * 1000);

        expect(getTodayIso()).toBe('2026-08-30');
        expect(vi.getTimerCount()).toBe(1);
    });

    it('unsubscribe stops notifications for that listener only', () => {
        const kept = vi.fn();
        const dropped = vi.fn();
        subscribeToDayChange(kept);
        const unsubscribe = subscribeToDayChange(dropped);
        unsubscribe();

        vi.advanceTimersByTime(2 * 60 * 1000);

        expect(kept).toHaveBeenCalledTimes(1);
        expect(dropped).not.toHaveBeenCalled();
    });
});
