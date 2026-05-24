import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { buildCalendarMeta, emptyCalendar } from '../components/clarify/types';
import type { CalendarOption } from '../hooks/useCalendarOptions';

const NO_OPTIONS: CalendarOption[] = [];

const ONE_OPTION: CalendarOption[] = [
    {
        configId: 'cfg-1',
        integrationId: 'int-1',
        userId: 'user-1',
        accountEmail: 'me@example.com',
        displayName: 'Primary',
        isDefault: true,
    },
];

describe('buildCalendarMeta — all-day branch', () => {
    it('encodes a single-day all-day event with date-only start and +1 day exclusive end', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-27', allDay: true }, NO_OPTIONS);
        expect(meta.timeStart).toBe('2026-05-27');
        expect(meta.timeEnd).toBe('2026-05-28');
        expect(meta.allDay).toBe(true);
    });

    it('encodes a multi-day all-day event with endDate + 1 day exclusive end', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-27', endDate: '2026-05-29', allDay: true }, NO_OPTIONS);
        expect(meta.timeStart).toBe('2026-05-27');
        // Inclusive endDate 2026-05-29 → exclusive 2026-05-30.
        expect(meta.timeEnd).toBe('2026-05-30');
        expect(meta.allDay).toBe(true);
    });

    it('treats an empty endDate as a single-day event', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-27', endDate: '', allDay: true }, NO_OPTIONS);
        expect(meta.timeStart).toBe('2026-05-27');
        expect(meta.timeEnd).toBe('2026-05-28');
    });

    // Documented clamp behavior: endDate < date is a user mistake (e.g. moved start forward,
    // forgot to update end). Coerce to single-day rather than emit a negative-duration event.
    it('clamps endDate < date down to a single-day event', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-27', endDate: '2026-05-20', allDay: true }, NO_OPTIONS);
        expect(meta.timeStart).toBe('2026-05-27');
        expect(meta.timeEnd).toBe('2026-05-28');
    });

    it('treats endDate === date as a single-day event (inclusive end of start day)', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-27', endDate: '2026-05-27', allDay: true }, NO_OPTIONS);
        expect(meta.timeStart).toBe('2026-05-27');
        expect(meta.timeEnd).toBe('2026-05-28');
    });

    it('shifts the exclusive end across month boundaries', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-31', allDay: true }, NO_OPTIONS);
        expect(meta.timeEnd).toBe('2026-06-01');
    });

    it('ignores startTime/endTime when allDay is true', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-27', startTime: '09:00', endTime: '17:00', allDay: true }, NO_OPTIONS);
        // Date-only strings prove the timed branch did not run.
        expect(meta.timeStart).toBe('2026-05-27');
        expect(meta.timeEnd).toBe('2026-05-28');
    });

    it('still attaches the calendar link when a sync config is selected', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-27', allDay: true, calendarSyncConfigId: 'cfg-1' }, ONE_OPTION);
        expect(meta.calendarSyncConfigId).toBe('cfg-1');
        expect(meta.calendarIntegrationId).toBe('int-1');
        expect(meta.allDay).toBe(true);
    });
});

describe('buildCalendarMeta — timed branch (unchanged)', () => {
    it('combines date + startTime into an ISO timeStart', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-04', startTime: '09:00', endTime: '10:00' }, NO_OPTIONS);
        // The exact ISO depends on the test runner's local tz, so assert via dayjs round-trip
        // rather than a hard-coded UTC string.
        expect(dayjs(meta.timeStart).format('YYYY-MM-DD HH:mm')).toBe('2026-05-04 09:00');
        expect(dayjs(meta.timeEnd).format('YYYY-MM-DD HH:mm')).toBe('2026-05-04 10:00');
        // `allDay` is never set on a timed event.
        expect(meta.allDay).toBeUndefined();
    });

    it('defaults missing endTime to start + 1 hour', () => {
        const meta = buildCalendarMeta({ ...emptyCalendar, date: '2026-05-04', startTime: '09:00' }, NO_OPTIONS);
        expect(dayjs(meta.timeEnd).diff(dayjs(meta.timeStart), 'minute')).toBe(60);
        expect(meta.allDay).toBeUndefined();
    });

    it('attaches the calendar link when a sync config is selected', () => {
        const meta = buildCalendarMeta(
            { ...emptyCalendar, date: '2026-05-04', startTime: '09:00', endTime: '10:00', calendarSyncConfigId: 'cfg-1' },
            ONE_OPTION,
        );
        expect(meta.calendarSyncConfigId).toBe('cfg-1');
        expect(meta.calendarIntegrationId).toBe('int-1');
        expect(meta.allDay).toBeUndefined();
    });
});
