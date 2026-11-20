import dayjs from 'dayjs';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Pins the device clock (Date only, so real timers still run) for every test in the enclosing
 * describe — e.g. so a fixture's year counts as "the current year" whenever the suite runs.
 */
export function pinClockAt(iso: string) {
    beforeEach(() => {
        vi.useFakeTimers({ now: dayjs(iso).valueOf(), toFake: ['Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });
}
