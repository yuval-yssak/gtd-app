/**
 * Coverage for `lib/splitChainResolution.ts` — walking a GCal "this and all following" split chain
 * to its terminal link. Fixture shapes mirror the live staging chains that motivated the feature
 * (capped base + open tail; deleted base + live quarterly tail; multi-link chains; a tail whose own
 * cap expired), with the ids anonymized.
 */
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import type { GCalEvent } from '../calendarProviders/CalendarProvider.js';
import {
    type ChainProvider,
    effectiveSeriesEndIso,
    rebasedAnchorOf,
    resolveSplitChainTerminal,
    type SplitChainResolution,
} from '../lib/splitChainResolution.js';

const NOW = '2026-08-31T12:00:00.000Z';
const CALENDAR_ID = 'primary';

function makeMaster(id: string, rrule: string | null, timeStart: string, overrides: Partial<GCalEvent> = {}): GCalEvent {
    return {
        id,
        title: 'Series',
        timeStart,
        timeEnd: timeStart,
        updated: '2026-08-01T00:00:00.000Z',
        status: 'confirmed',
        ...(rrule ? { recurrence: [`RRULE:${rrule}`] } : {}),
        ...overrides,
    };
}

function makeInstance(recurringEventId: string, timeStart: string): GCalEvent {
    return {
        id: `${recurringEventId}_${timeStart.replace(/[-:]/g, '').slice(0, 15)}Z`,
        title: 'Series',
        timeStart,
        timeEnd: timeStart,
        updated: '2026-08-01T00:00:00.000Z',
        status: 'confirmed',
        recurringEventId,
    };
}

interface FakeCalls {
    getEvent: string[];
    listEvents: Array<{ since: string; until: string }>;
}

/** Tiny in-memory ChainProvider: `masters` answers getEvent; `instances` answers windowed listEvents. */
function fakeChainProvider(masters: Record<string, GCalEvent | null>, instances: GCalEvent[]): { provider: ChainProvider; calls: FakeCalls } {
    const calls: FakeCalls = { getEvent: [], listEvents: [] };
    const provider: ChainProvider = {
        getEvent: (_calendarId, eventId) => {
            calls.getEvent.push(eventId);
            return Promise.resolve(masters[eventId] ?? null);
        },
        listEvents: (_calendarId, since, until) => {
            calls.listEvents.push({ since, until });
            return Promise.resolve(instances.filter((i) => !dayjs(i.timeStart).isBefore(dayjs(since)) && !dayjs(i.timeStart).isAfter(dayjs(until))));
        },
    };
    return { provider, calls };
}

function expectLive(resolution: SplitChainResolution): Extract<SplitChainResolution, { status: 'live' }> {
    expect(resolution.status).toBe('live');
    if (resolution.status !== 'live') throw new Error('expected a live resolution');
    return resolution;
}

function expectOver(resolution: SplitChainResolution): Extract<SplitChainResolution, { status: 'over' }> {
    expect(resolution.status).toBe('over');
    if (resolution.status !== 'over') throw new Error('expected an over resolution');
    return resolution;
}

describe('rebasedAnchorOf', () => {
    it('extracts timed, Z-suffixed and all-day anchors, and returns empty for a bare id', () => {
        expect(rebasedAnchorOf('abc123_R20260827T140000')).toBe('20260827T140000');
        expect(rebasedAnchorOf('abc123_R20260827T140000Z')).toBe('20260827T140000Z');
        expect(rebasedAnchorOf('abc123_R20260628')).toBe('20260628');
        expect(rebasedAnchorOf('abc123')).toBe('');
        // An INSTANCE-form suffix (no `_R`) is not a rebased anchor.
        expect(rebasedAnchorOf('abc123_20260827T140000Z')).toBe('');
    });
});

describe('effectiveSeriesEndIso', () => {
    it('returns the UNTIL cutoff for capped rules (datetime form verbatim; bare-date form pushed to end of that day)', () => {
        expect(effectiveSeriesEndIso('FREQ=WEEKLY;BYDAY=TH;UNTIL=20260722T235959Z', '2026-01-01T14:00:00Z')).toBe('2026-07-22T23:59:59.000Z');
        // A date-only UNTIL is inclusive of the whole day: an all-day occurrence ON 2026-08-30 is
        // still real, so the series end must sort after any timestamp on that date.
        expect(effectiveSeriesEndIso('FREQ=DAILY;UNTIL=20260830', '2026-01-01')).toBe('2026-08-30T23:59:59.999Z');
    });

    it('returns the last COUNT-bounded occurrence', () => {
        // 5 weekly occurrences from 2026-07-01: 7/1, 7/8, 7/15, 7/22, 7/29.
        expect(effectiveSeriesEndIso('FREQ=WEEKLY;COUNT=5', '2026-07-01T09:00:00Z')).toBe('2026-07-29T09:00:00.000Z');
    });

    it('returns null for open rules and for a pathological COUNT it refuses to expand', () => {
        expect(effectiveSeriesEndIso('FREQ=WEEKLY;BYDAY=TU', '2026-01-01T09:00:00Z')).toBeNull();
        expect(effectiveSeriesEndIso('FREQ=DAILY;COUNT=999999', '2026-01-01T09:00:00Z')).toBeNull();
    });

    it('treats a malformed COUNT rule as open instead of throwing (RRule.fromString throws on bad rules)', () => {
        expect(effectiveSeriesEndIso('FREQ=BOGUS;COUNT=5', '2026-01-01T09:00:00Z')).toBeNull();
    });
});

describe('resolveSplitChainTerminal', () => {
    it('an open bare master is its own live terminal — no continuation search', async () => {
        const { provider, calls } = fakeChainProvider({ base1: makeMaster('base1', 'FREQ=WEEKLY;BYDAY=MO', '2026-01-05T09:00:00Z') }, []);

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base1', NOW));

        expect(resolution.terminal.rawId).toBe('base1');
        expect(resolution.terminal.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        expect(calls.listEvents).toHaveLength(0);
    });

    it('a FUTURE-capped link is treated as live terminal (an upcoming split still owns the present)', async () => {
        const { provider, calls } = fakeChainProvider({ base2: makeMaster('base2', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261230T235959Z', '2026-01-05T09:00:00Z') }, [
            makeInstance('base2_R20270104T090000', '2027-01-04T09:00:00Z'),
        ]);

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base2', NOW));

        expect(resolution.terminal.rawId).toBe('base2');
        // Following the future tail early would regenerate near-term items on the successor's schedule.
        expect(calls.listEvents).toHaveLength(0);
    });

    it('follows a past-capped base to its open continuation (capped-base + live-tail staging shape)', async () => {
        const { provider } = fakeChainProvider(
            {
                base3: makeMaster('base3', 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260722T235959Z', '2025-10-02T14:00:00Z'),
                base3_R20260827T140000: makeMaster('base3_R20260827T140000', 'FREQ=WEEKLY;BYDAY=TH', '2026-08-27T14:00:00Z'),
            },
            [makeInstance('base3_R20260827T140000', '2026-09-03T14:00:00Z')],
        );

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base3', NOW));

        expect(resolution.terminal.rawId).toBe('base3_R20260827T140000');
        expect(resolution.terminal.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        expect(resolution.hops).toBe(1);
    });

    it('recovers a live continuation when the base was deleted outright (404 base, quarterly staging shape)', async () => {
        const { provider } = fakeChainProvider(
            {
                // base4 absent → getEvent returns null (404).
                base4_R20260622T113000: makeMaster('base4_R20260622T113000', 'FREQ=MONTHLY;INTERVAL=3;BYDAY=4MO', '2026-06-22T11:30:00Z'),
            },
            [makeInstance('base4_R20260622T113000', '2026-09-28T11:30:00Z')],
        );

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base4', NOW));

        expect(resolution.terminal.rawId).toBe('base4_R20260622T113000');
    });

    it('walks a multi-link chain hop by hop when each window only reveals the next link', async () => {
        const { provider } = fakeChainProvider(
            {
                base5: makeMaster('base5', 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20241005T235959Z', '2024-01-06T09:00:00Z'),
                base5_R20241012T090000: makeMaster('base5_R20241012T090000', 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20250601T235959Z', '2024-10-12T09:00:00Z'),
                base5_R20260628T090000: makeMaster('base5_R20260628T090000', 'FREQ=WEEKLY;BYDAY=SU', '2026-06-28T09:00:00Z'),
            },
            [
                // Only the middle link's instance falls inside the base's continuation window
                // (2024-10 → late 2025); the terminal's first instance (2026-06) needs the second hop.
                makeInstance('base5_R20241012T090000', '2024-10-12T09:00:00Z'),
                makeInstance('base5_R20260628T090000', '2026-06-28T09:00:00Z'),
            ],
        );

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base5', NOW));

        expect(resolution.terminal.rawId).toBe('base5_R20260628T090000');
        expect(resolution.hops).toBe(2);
    });

    it('jumps straight to the furthest link visible in one window (max-anchor pick)', async () => {
        const { provider } = fakeChainProvider(
            {
                base6: makeMaster('base6', 'FREQ=DAILY;UNTIL=20260601T235959Z', '2026-01-01T09:00:00Z'),
                base6_R20260610T090000: makeMaster('base6_R20260610T090000', 'FREQ=DAILY;UNTIL=20260701T235959Z', '2026-06-10T09:00:00Z'),
                base6_R20260710T090000: makeMaster('base6_R20260710T090000', 'FREQ=DAILY', '2026-07-10T09:00:00Z'),
            },
            [makeInstance('base6_R20260610T090000', '2026-06-10T09:00:00Z'), makeInstance('base6_R20260710T090000', '2026-07-10T09:00:00Z')],
        );

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base6', NOW));

        expect(resolution.terminal.rawId).toBe('base6_R20260710T090000');
        expect(resolution.hops).toBe(1);
    });

    it('reports a chain as over when the terminal link expired with no continuation (phantom-generator staging shape)', async () => {
        const { provider } = fakeChainProvider(
            {
                base7: makeMaster('base7', 'FREQ=DAILY;UNTIL=20260810T235959Z', '2024-10-01T07:30:00Z'),
                base7_R20260811T073000: makeMaster('base7_R20260811T073000', 'FREQ=DAILY;UNTIL=20260830T235959Z', '2026-08-11T07:30:00Z'),
            },
            [
                makeInstance('base7_R20260811T073000', '2026-08-12T07:30:00Z'),
                // Terminal's own instances must NOT count as continuations of themselves (strict-forward anchor filter).
                makeInstance('base7_R20260811T073000', '2026-08-30T07:30:00Z'),
            ],
        );

        const resolution = expectOver(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base7', NOW));

        expect(resolution.terminal.rawId).toBe('base7_R20260811T073000');
        expect(resolution.terminal.endedAt).toBe('2026-08-30T23:59:59.000Z');
    });

    it('reports a COUNT-exhausted terminal as over, at its last occurrence', async () => {
        const { provider } = fakeChainProvider(
            { base8_R20260701T090000: makeMaster('base8_R20260701T090000', 'FREQ=WEEKLY;COUNT=5', '2026-07-01T09:00:00Z') },
            [],
        );

        const resolution = expectOver(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base8_R20260701T090000', NOW));

        expect(resolution.terminal.endedAt).toBe('2026-07-29T09:00:00.000Z');
    });

    it('treats a COUNT series whose last occurrence is still ahead as live', async () => {
        const { provider } = fakeChainProvider({ base9: makeMaster('base9', 'FREQ=WEEKLY;COUNT=5', '2026-08-27T09:00:00Z') }, []);

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base9', NOW));

        expect(resolution.terminal.rawId).toBe('base9');
    });

    it('is unresolved for a gone link with no discoverable continuation (owned by the cancellation machinery)', async () => {
        const { provider } = fakeChainProvider({}, []);

        const resolution = await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base10', NOW);

        expect(resolution.status).toBe('unresolved');
    });

    it('walks an all-day chain (bare-date timeStarts, date-only _R anchors) to its live terminal', async () => {
        const { provider } = fakeChainProvider(
            {
                base13: { ...makeMaster('base13', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601', '2026-01-05'), allDay: true },
                base13_R20260608: { ...makeMaster('base13_R20260608', 'FREQ=WEEKLY;BYDAY=MO', '2026-06-08'), allDay: true },
            },
            [{ ...makeInstance('base13_R20260608', '2026-06-08'), allDay: true }],
        );

        const resolution = expectLive(await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base13', NOW));

        expect(resolution.terminal.rawId).toBe('base13_R20260608');
        expect(resolution.terminal.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    });

    it('is unresolved for a confirmed master with no RRULE', async () => {
        const { provider } = fakeChainProvider({ base11: makeMaster('base11', null, '2026-01-01T09:00:00Z') }, []);

        const resolution = await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base11', NOW);

        expect(resolution.status).toBe('unresolved');
    });

    it('stops at the hop cap on a pathologically long chain instead of walking it forever', async () => {
        // 14 links, each capped and spaced >400 days apart so every continuation window reveals
        // exactly one next link — forcing one hop per link.
        const masters: Record<string, GCalEvent | null> = {};
        const instances: GCalEvent[] = [];
        const start = dayjs.utc('2000-01-03T09:00:00Z');
        const linkId = (index: number) => (index === 0 ? 'base12' : `base12_R${start.add(index * 401, 'day').format('YYYYMMDD[T]HHmmss')}`);
        for (let index = 0; index < 14; index++) {
            const linkStart = start.add(index * 401, 'day');
            const until = linkStart.add(300, 'day').format('YYYYMMDD[T]235959[Z]');
            masters[linkId(index)] = makeMaster(linkId(index), `FREQ=WEEKLY;UNTIL=${until}`, linkStart.toISOString());
            instances.push(makeInstance(linkId(index), linkStart.toISOString()));
        }
        const { provider } = fakeChainProvider(masters, instances);

        const resolution = await resolveSplitChainTerminal(provider, CALENDAR_ID, 'base12', '2026-08-31T12:00:00.000Z');

        expect(resolution.status).toBe('unresolved');
        if (resolution.status !== 'unresolved') {
            throw new Error('expected an unresolved resolution');
        }
        expect(resolution.reason).toContain('hop cap');
    });
});
