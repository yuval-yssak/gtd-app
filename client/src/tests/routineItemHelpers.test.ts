import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { getCalendarCompletionTiming } from '../db/routineItemHelpers';

describe('getCalendarCompletionTiming', () => {
    it('returns onTime when completion is within 24h of timeStart', () => {
        const timeStart = '2024-03-14T18:00:00';
        // Completed 2h after start — well within the 24h window
        const completionDate = new Date('2024-03-14T20:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });

    it('returns late when completion is more than 24h after timeStart', () => {
        const timeStart = '2024-03-14T18:00:00';
        // 48h after start — well past the 24h window
        const completionDate = new Date('2024-03-16T18:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('late');
    });

    it('returns onTime when completed exactly 24h after timeStart (boundary — isAfter is strict)', () => {
        // The implementation uses dayjs.isAfter which is strictly greater than.
        // Both sides use dayjs local time so the comparison is timezone-independent.
        const timeStart = '2024-03-14T12:00:00';
        // Exactly 24h later in local time — NOT after the boundary, so must be 'onTime'
        const completionDate = dayjs('2024-03-14T12:00:00').add(24, 'hour').toDate();
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });

    it('returns onTime when completed before timeStart (trashed before due)', () => {
        const timeStart = '2024-03-20T10:00:00';
        // Completed a week before the event
        const completionDate = new Date('2024-03-13T10:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });
});
