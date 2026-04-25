import { describe, expect, it } from 'vitest';
import { resolveInboundNotes } from '../routes/calendar.js';

describe('resolveInboundNotes', () => {
    const olderTs = '2026-04-10T10:00:00.000Z';
    const newerTs = '2026-04-10T12:00:00.000Z';

    it('detects deletion when gcalDescription is undefined but lastSyncedNotes existed (GCal newer)', () => {
        expect(resolveInboundNotes(undefined, 'old notes', newerTs, olderTs)).toEqual({
            notes: '',
            lastSyncedNotes: '',
        });
    });

    it('returns null when gcalDescription is undefined and lastSyncedNotes is also undefined', () => {
        expect(resolveInboundNotes(undefined, undefined, newerTs, olderTs)).toBeNull();
    });

    it('returns null when gcalDescription matches lastSyncedNotes (no change on GCal side)', () => {
        expect(resolveInboundNotes('same notes', 'same notes', newerTs, olderTs)).toBeNull();
    });

    it('returns GCal description when GCal changed and is newer', () => {
        expect(resolveInboundNotes('new from gcal', 'old synced', newerTs, olderTs)).toEqual({
            notes: 'new from gcal',
            lastSyncedNotes: 'new from gcal',
        });
    });

    it('returns null when GCal changed but local is newer', () => {
        expect(resolveInboundNotes('new from gcal', 'old synced', olderTs, newerTs)).toBeNull();
    });

    it('handles empty string from GCal clearing the description (GCal newer)', () => {
        expect(resolveInboundNotes('', 'had notes', newerTs, olderTs)).toEqual({
            notes: '',
            lastSyncedNotes: '',
        });
    });

    it('handles empty string from GCal clearing the description (local newer)', () => {
        expect(resolveInboundNotes('', 'had notes', olderTs, newerTs)).toBeNull();
    });

    it('returns null when empty string from GCal and undefined lastSyncedNotes (both normalize to empty)', () => {
        expect(resolveInboundNotes('', undefined, newerTs, olderTs)).toBeNull();
    });

    it('returns null when both gcalDescription and lastSyncedNotes are empty string', () => {
        expect(resolveInboundNotes('', '', newerTs, olderTs)).toBeNull();
    });

    it('detects first-time description on never-synced item (GCal newer)', () => {
        expect(resolveInboundNotes('first description', undefined, newerTs, olderTs)).toEqual({
            notes: 'first description',
            lastSyncedNotes: 'first description',
        });
    });

    it('preserves local notes on first sync when local is newer', () => {
        expect(resolveInboundNotes('first description', undefined, olderTs, newerTs)).toBeNull();
    });

    it('returns GCal description when timestamps are in the same second (GCal wins on tie at second precision)', () => {
        // GCal's event.updated is second-precision; local updatedTs is millisecond. A local write
        // followed by a GCal change within the same wall-clock second must still be picked up.
        const localTs = '2026-04-10T10:00:00.200Z';
        const gcalTs = '2026-04-10T10:00:00.000Z';
        expect(resolveInboundNotes('changed on gcal', 'old synced', gcalTs, localTs)).toEqual({
            notes: 'changed on gcal',
            lastSyncedNotes: 'changed on gcal',
        });
    });
});
