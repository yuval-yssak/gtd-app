import { describe, expect, it } from 'vitest';
import { buildDateTime, endDateTime } from '../calendarProviders/GoogleCalendarProvider.js';

describe('buildDateTime', () => {
    it('builds a valid dateTime for HH:MM input', () => {
        expect(buildDateTime('2026-04-11', '09:00', 'UTC')).toEqual({ dateTime: '2026-04-11T09:00:00', timeZone: 'UTC' });
    });

    it('handles 23:59 (end of day)', () => {
        expect(buildDateTime('2026-04-11', '23:59', 'UTC')).toEqual({ dateTime: '2026-04-11T23:59:00', timeZone: 'UTC' });
    });

    it('throws for empty string', () => {
        expect(() => buildDateTime('2026-04-11', '', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for single-digit hour', () => {
        expect(() => buildDateTime('2026-04-11', '9:00', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for format with seconds', () => {
        expect(() => buildDateTime('2026-04-11', '09:00:00', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for out-of-range hour', () => {
        expect(() => buildDateTime('2026-04-11', '25:00', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for out-of-range minutes', () => {
        expect(() => buildDateTime('2026-04-11', '12:60', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('accepts 00:00 (midnight)', () => {
        expect(buildDateTime('2026-04-11', '00:00', 'UTC')).toEqual({ dateTime: '2026-04-11T00:00:00', timeZone: 'UTC' });
    });
});

describe('endDateTime', () => {
    it('adds duration to start time', () => {
        expect(endDateTime('2026-04-11', '09:00', 60, 'UTC')).toEqual({ dateTime: '2026-04-11T10:00:00', timeZone: 'UTC' });
    });

    it('handles midnight overflow', () => {
        expect(endDateTime('2026-04-11', '23:00', 120, 'UTC')).toEqual({ dateTime: '2026-04-12T01:00:00', timeZone: 'UTC' });
    });

    it('throws for empty timeOfDay', () => {
        expect(() => endDateTime('2026-04-11', '', 60, 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for invalid timeOfDay format', () => {
        expect(() => endDateTime('2026-04-11', '9:00', 30, 'UTC')).toThrow('Invalid timeOfDay');
    });
});
