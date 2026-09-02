/**
 * Coverage for the full-sync split-chain anchor heal (`healSplitChainAnchors` in routes/calendar.ts).
 *
 * Class A — stale anchor, series alive: an active routine anchored at a capped/deleted chain link
 * while a live continuation exists is re-anchored IN PLACE onto the terminal (rebased key + terminal
 * rrule/template through `updateRoutineFromGCal`), idempotently.
 * Class B — chain over: an active routine whose chain's terminal link expired is retired through the
 * inbound pause discipline (cap + active:false + retiredByGCal + item trash + recorded ops) with
 * DELIBERATELY zero Google Calendar writes — the mutation-spy assertions below are the explicit,
 * tested form of that skip.
 *
 * The convergence suite at the bottom is the regression net for the known flap/kill class: a
 * re-anchored routine is the ONLY row on its bare id and carries `calendarRebasedEventId`, so a
 * later re-report of the CAPPED BASE master must mint an inactive base row instead of capping and
 * killing the live tail (the one-way kill `findExistingRoutineForEvent`'s old fallback allowed).
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GCalEvent } from '../calendarProviders/CalendarProvider.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type { ChainProvider } from '../lib/splitChainResolution.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { type CalendarSource, healSplitChainAnchors, importCalendarEvents } from '../routes/calendar.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';

const USER = 'user-split-chain-heal';
const NOW = '2026-08-31T12:00:00.000Z';
const TERMINAL_ID = 'chain-base_R20260827T140000';
const DEAD_TERMINAL_ID = 'chain-base_R20260811T073000';

const integration: CalendarIntegrationInterface = {
    _id: 'int-chain',
    user: USER,
    provider: 'google',
    accessToken: 'enc-access',
    refreshToken: 'enc-refresh',
    tokenExpiry: '2027-01-01T00:00:00.000Z',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

const config: CalendarSyncConfigInterface = {
    _id: 'cfg-chain',
    integrationId: 'int-chain',
    user: USER,
    calendarId: 'primary',
    isDefault: true,
    enabled: true,
    timeZone: 'UTC',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

const source: CalendarSource = { integration, config };

function makeCtx() {
    return { userId: USER, now: NOW, ops: [] as OperationInterface[], timeZone: 'UTC' };
}

function makeRoutine(id: string, overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    return {
        _id: id,
        user: USER,
        title: 'Chained Series',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
        calendarItemTemplate: { timeOfDay: '14:00', duration: 60 },
        calendarEventId: 'chain-base',
        calendarIntegrationId: 'int-chain',
        calendarSyncConfigId: 'cfg-chain',
        createdTs: '2025-10-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeItem(id: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: id,
        user: USER,
        title: 'Chained Series',
        status: 'calendar',
        timeStart: '2026-09-07T14:00:00Z',
        timeEnd: '2026-09-07T15:00:00Z',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeMaster(id: string, rrule: string, timeStart: string, overrides: Partial<GCalEvent> = {}): GCalEvent {
    return {
        id,
        title: 'Chained Series',
        timeStart,
        timeEnd: timeStart,
        updated: '2026-08-27T10:00:00.000Z',
        status: 'confirmed',
        recurrence: [`RRULE:${rrule}`],
        ...overrides,
    };
}

function makeInstance(recurringEventId: string, timeStart: string): GCalEvent {
    return {
        id: `${recurringEventId}-instance-${timeStart}`,
        title: 'Chained Series',
        timeStart,
        timeEnd: timeStart,
        updated: '2026-08-27T10:00:00.000Z',
        status: 'confirmed',
        recurringEventId,
    };
}

/** Destructure-then-narrow loader — a vanished routine fails loudly instead of as `undefined !== expected`. */
async function loadRoutine(id: string): Promise<RoutineInterface> {
    const routine = await routinesDAO.findByOwnerAndId(id, USER);
    if (!routine) {
        throw new Error(`expected routine ${id} to exist`);
    }
    return routine;
}

async function loadItem(id: string): Promise<ItemInterface> {
    const item = await itemsDAO.findByOwnerAndId(id, USER);
    if (!item) {
        throw new Error(`expected item ${id} to exist`);
    }
    return item;
}

/**
 * ChainProvider fake with GCal MUTATION SPIES attached. `healSplitChainAnchors` only receives the
 * two read methods by type, but the spies prove the heal path performs zero Google writes — the
 * explicit "no UNTIL-cap pushback" guarantee for the dead-chain retire.
 */
function fakeProvider(masters: Record<string, GCalEvent | null>, instances: GCalEvent[]) {
    const mutations = {
        capRecurringEvent: vi.fn(),
        updateRecurringEvent: vi.fn(),
        deleteRecurringEvent: vi.fn(),
        createEvent: vi.fn(),
        updateEvent: vi.fn(),
        deleteEvent: vi.fn(),
    };
    const provider: ChainProvider = {
        getEvent: (_calendarId, eventId) => Promise.resolve(masters[eventId] ?? null),
        listEvents: (_calendarId, since, until) =>
            Promise.resolve(instances.filter((i) => !dayjs(i.timeStart).isBefore(dayjs(since)) && !dayjs(i.timeStart).isAfter(dayjs(until)))),
    };
    return { provider: Object.assign(provider, mutations), mutations };
}

function expectNoGCalWrites(mutations: ReturnType<typeof fakeProvider>['mutations']): void {
    for (const [name, spy] of Object.entries(mutations)) {
        expect(spy, `expected no GCal write via ${name}`).not.toHaveBeenCalled();
    }
}

const chainAFixture = () =>
    fakeProvider(
        {
            'chain-base': makeMaster('chain-base', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260722T235959Z', '2025-10-06T14:00:00Z', {
                updated: '2026-08-27T10:00:00.000Z',
            }),
            [TERMINAL_ID]: makeMaster(TERMINAL_ID, 'FREQ=WEEKLY;BYDAY=TH', '2026-08-27T14:00:00Z', { updated: '2026-08-27T10:00:01.000Z' }),
        },
        [makeInstance(TERMINAL_ID, '2026-09-03T14:00:00Z')],
    );

const chainBFixture = () =>
    fakeProvider(
        {
            'chain-base': makeMaster('chain-base', 'FREQ=DAILY;UNTIL=20260810T235959Z', '2024-10-01T07:30:00Z'),
            [DEAD_TERMINAL_ID]: makeMaster(DEAD_TERMINAL_ID, 'FREQ=DAILY;UNTIL=20260830T235959Z', '2026-08-11T07:30:00Z'),
        },
        [makeInstance(DEAD_TERMINAL_ID, '2026-08-12T07:30:00Z')],
    );

beforeAll(async () => {
    await loadDataAccess('gtd_test_split_chain_heal');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('routines').deleteMany({}), db.collection('items').deleteMany({}), db.collection('operations').deleteMany({})]);
});

describe('healSplitChainAnchors — Class A (stale anchor, live continuation)', () => {
    it('re-anchors the routine onto the live terminal: rebased key, terminal rrule, recorded op, regenerated items', async () => {
        await routinesDAO.insertOne(makeRoutine('r-class-a', { lastSyncedFromGCalTs: '2026-07-01T00:00:00.000Z' }));
        // A future item still on the OLD (Monday) schedule — regeneration must move the series to Thursdays.
        await itemsDAO.insertOne(
            makeItem('i-old-schedule', { routineId: 'r-class-a', timeStart: '2026-09-07T14:00:00Z', calendarInstanceEventId: 'chain-base_20260907T140000Z' }),
        );
        const { provider } = chainAFixture();
        const ctx = makeCtx();

        await healSplitChainAnchors(source, provider, ctx);

        const healed = await loadRoutine('r-class-a');
        expect(healed.calendarRebasedEventId).toBe(TERMINAL_ID);
        expect(healed.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        expect(healed.calendarEventId).toBe('chain-base'); // stays BARE — instance ids key on it
        expect(healed.active).toBe(true);
        expect(healed.lastSyncedFromGCalTs).toBe('2026-08-27T10:00:01.000Z');
        expect(ctx.ops.some((op) => op.entityType === 'routine' && op.entityId === 'r-class-a')).toBe(true);

        const items = await itemsDAO.findArray({ user: USER, routineId: 'r-class-a', status: 'calendar' });
        expect(items.length).toBeGreaterThan(0);
        // Every live item now sits on the terminal's Thursday schedule; the Monday leftover is gone.
        for (const item of items) {
            expect(dayjs(item.timeStart).day()).toBe(4);
        }
        const oldItem = await loadItem('i-old-schedule');
        expect(oldItem.status).toBe('trash');
    });

    it('is idempotent — a second sweep resolves the rebased anchor in one read and records nothing', async () => {
        await routinesDAO.insertOne(makeRoutine('r-idem'));
        const first = chainAFixture();
        await healSplitChainAnchors(source, first.provider, makeCtx());
        const afterFirst = await loadRoutine('r-idem');

        const second = chainAFixture();
        const ctx2 = makeCtx();
        await healSplitChainAnchors(source, second.provider, ctx2);

        expect(ctx2.ops).toHaveLength(0);
        const afterSecond = await loadRoutine('r-idem');
        expect(afterSecond).toEqual(afterFirst);
    });

    it('advances lastSyncedFromGCalTs past a stale base anchor so a stale base re-report cannot re-cap the routine', async () => {
        // The stored anchor (stamped by re-reports of the dead base) POST-dates the terminal's
        // `updated` — the exact shape where the raw structural gate would block the rrule fix, and
        // where writing the terminal's older `updated` back would re-open the door to the base.
        await routinesDAO.insertOne(makeRoutine('r-anchor-max', { lastSyncedFromGCalTs: '2026-08-30T00:00:00.000Z' }));
        const { provider } = chainAFixture();

        await healSplitChainAnchors(source, provider, makeCtx());

        const healed = await loadRoutine('r-anchor-max');
        expect(healed.rrule).toBe('FREQ=WEEKLY;BYDAY=TH'); // the gate did not block the heal
        expect(healed.lastSyncedFromGCalTs).toBe('2026-08-30T00:00:00.000Z'); // max(stale anchor, terminal.updated)
    });

    it('defers to an existing successor routine that already owns the terminal tail (two-row split model)', async () => {
        await routinesDAO.insertOne(makeRoutine('r-stale-base', { rrule: 'FREQ=WEEKLY;BYDAY=MO' }));
        await routinesDAO.insertOne(
            makeRoutine('r-tail-owner', {
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarRebasedEventId: TERMINAL_ID,
                splitFromRoutineId: 'r-stale-base',
            }),
        );
        const { provider } = chainAFixture();
        const ctx = makeCtx();

        await healSplitChainAnchors(source, provider, ctx);

        const untouched = await loadRoutine('r-stale-base');
        expect(untouched.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        expect(untouched.calendarRebasedEventId).toBeUndefined();
        expect(ctx.ops).toHaveLength(0);
    });
});

describe('healSplitChainAnchors — Class B (chain over)', () => {
    it('retires the routine via the pause discipline — cap, retiredByGCal, phantom-item trash, ops — with ZERO GCal writes', async () => {
        await routinesDAO.insertOne(makeRoutine('r-class-b', { rrule: 'FREQ=DAILY', calendarItemTemplate: { timeOfDay: '07:30', duration: 30 } }));
        await itemsDAO.insertMany([
            // Generated after the terminal died but before "now" — the phantom gap the plain pause trash misses.
            makeItem('i-gap', { routineId: 'r-class-b', timeStart: '2026-08-31T07:30:00Z', calendarInstanceEventId: 'chain-base_20260831T073000Z' }),
            makeItem('i-future', { routineId: 'r-class-b', timeStart: '2026-09-05T07:30:00Z', calendarInstanceEventId: 'chain-base_20260905T073000Z' }),
            // Real past occurrence from when the series was alive — must survive.
            makeItem('i-past', { routineId: 'r-class-b', timeStart: '2026-08-20T07:30:00Z' }),
        ]);
        const { provider, mutations } = chainBFixture();
        const ctx = makeCtx();

        await healSplitChainAnchors(source, provider, ctx);

        const retired = await loadRoutine('r-class-b');
        expect(retired.active).toBe(false);
        expect(retired.retiredByGCal).toBe(true);
        expect(retired.rrule).toContain('UNTIL='); // capped locally (reversible retirement)
        expect(ctx.ops.some((op) => op.entityType === 'routine' && op.entityId === 'r-class-b')).toBe(true);

        const gap = await loadItem('i-gap');
        const future = await loadItem('i-future');
        const past = await loadItem('i-past');
        expect(gap.status).toBe('trash');
        expect(gap.calendarInstanceEventId).toBeUndefined();
        expect(future.status).toBe('trash');
        expect(past.status).toBe('calendar');
        expect(ctx.ops.filter((op) => op.entityType === 'item').length).toBeGreaterThanOrEqual(2);

        expectNoGCalWrites(mutations);
    });

    it('never moves an already-past LOCAL cap forward when retiring (mirrors the rrulePinnedUntil guarantee)', async () => {
        await routinesDAO.insertOne(
            makeRoutine('r-past-cap', { rrule: 'FREQ=DAILY;UNTIL=20260701T235959Z', calendarItemTemplate: { timeOfDay: '07:30', duration: 30 } }),
        );
        const { provider, mutations } = chainBFixture();

        await healSplitChainAnchors(source, provider, makeCtx());

        const retired = await loadRoutine('r-past-cap');
        expect(retired.active).toBe(false);
        expect(retired.retiredByGCal).toBe(true);
        // Re-capping from "today" would EXTEND the already-ended local rrule — it must stay put.
        expect(retired.rrule).toBe('FREQ=DAILY;UNTIL=20260701T235959Z');
        expectNoGCalWrites(mutations);
    });

    it('is idempotent — the retired routine drops out of the active sweep scope', async () => {
        await routinesDAO.insertOne(makeRoutine('r-class-b-idem', { rrule: 'FREQ=DAILY', calendarItemTemplate: { timeOfDay: '07:30', duration: 30 } }));
        const first = chainBFixture();
        await healSplitChainAnchors(source, first.provider, makeCtx());

        const second = chainBFixture();
        const ctx2 = makeCtx();
        await healSplitChainAnchors(source, second.provider, ctx2);

        expect(ctx2.ops).toHaveLength(0);
        expectNoGCalWrites(second.mutations);
    });
});

describe('healSplitChainAnchors — conservative skips', () => {
    it('leaves a routine untouched when the chain is unresolved (anchor gone, no discoverable continuation)', async () => {
        await routinesDAO.insertOne(makeRoutine('r-unresolved'));
        const { provider } = fakeProvider({}, []);
        const ctx = makeCtx();

        await healSplitChainAnchors(source, provider, ctx);

        const untouched = await loadRoutine('r-unresolved');
        expect(untouched.active).toBe(true);
        expect(untouched.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        expect(ctx.ops).toHaveLength(0);
    });

    it('leaves a healthy routine anchored at its own open master untouched', async () => {
        await routinesDAO.insertOne(makeRoutine('r-healthy'));
        const { provider } = fakeProvider({ 'chain-base': makeMaster('chain-base', 'FREQ=WEEKLY;BYDAY=MO', '2025-10-06T14:00:00Z') }, []);
        const ctx = makeCtx();

        await healSplitChainAnchors(source, provider, ctx);

        expect(ctx.ops).toHaveLength(0);
        const untouched = await loadRoutine('r-healthy');
        expect(untouched.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    });

    it('never touches inactive routines or other integrations', async () => {
        await routinesDAO.insertOne(makeRoutine('r-paused', { active: false }));
        await routinesDAO.insertOne(makeRoutine('r-other-int', { calendarIntegrationId: 'int-other', calendarEventId: 'other-base' }));
        const { provider } = fakeProvider({}, []);
        const getEvent = vi.spyOn(provider, 'getEvent');
        const ctx = makeCtx();

        await healSplitChainAnchors(source, provider, ctx);

        expect(getEvent).not.toHaveBeenCalled();
        expect(ctx.ops).toHaveLength(0);
    });
});

/**
 * Post-heal convergence with the inbound importer. After the in-place re-anchor, the routine is the
 * ONLY row on its bare id and carries `calendarRebasedEventId` — the shape whose mishandling
 * historically caused the rrule flap that trashed+recreated all items every webhook, and (with the
 * old `findExistingRoutineForEvent` fallback) a one-way kill: a capped-base re-report capped+paused
 * the live tail and trashed its future items with nothing ever reclaiming it.
 */
describe('post-re-anchor convergence with inbound sync', () => {
    /** The exact single-row shape `healSplitChainAnchors` leaves behind after a Class A re-anchor. */
    function seedReanchoredRoutine() {
        return routinesDAO.insertOne(
            makeRoutine('r-reanchored', {
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarRebasedEventId: TERMINAL_ID,
                lastSyncedFromGCalTs: '2026-08-27T10:00:01.000Z',
            }),
        );
    }

    it('REGRESSION: a later capped-base re-report with a fresh `updated` must not cap/kill the re-anchored routine', async () => {
        await seedReanchoredRoutine();
        await itemsDAO.insertOne(
            makeItem('i-tail-item', { routineId: 'r-reanchored', timeStart: '2026-09-03T14:00:00Z', calendarInstanceEventId: 'chain-base_20260903T140000Z' }),
        );
        // The base master re-reports with `updated` NEWER than the routine's stamped anchor — the
        // shape where the LWW max-advance alone cannot protect the tail.
        const cappedBase = makeMaster('chain-base', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260722T235959Z', '2025-10-06T14:00:00Z', {
            updated: '2026-08-31T09:00:00.000Z',
        });

        await importCalendarEvents(source, [cappedBase], makeCtx());

        const tail = await loadRoutine('r-reanchored');
        expect(tail.active).toBe(true);
        expect(tail.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        expect((await loadItem('i-tail-item')).status).toBe('calendar');
        // The capped base self-minted its own INACTIVE row instead — the hardened two-row shape.
        const onSeries = await routinesDAO.findArray({ user: USER, calendarEventId: 'chain-base', calendarIntegrationId: 'int-chain' });
        expect(onSeries).toHaveLength(2);
        const mintedBase = onSeries.find((routine) => routine._id !== 'r-reanchored');
        if (!mintedBase) {
            throw new Error('expected a self-minted base routine row');
        }
        expect(mintedBase.active).toBe(false);
        expect(mintedBase.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260722T235959Z');
        expect(mintedBase.calendarRebasedEventId).toBeUndefined();

        // Re-delivering the same base is a no-op: no new routine rows, tail still untouched.
        const ctx2 = makeCtx();
        await importCalendarEvents(source, [cappedBase], ctx2);
        expect(await routinesDAO.findArray({ user: USER, calendarEventId: 'chain-base', calendarIntegrationId: 'int-chain' })).toHaveLength(2);
        expect((await loadRoutine('r-reanchored')).rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
    });

    it('a re-report of the terminal _R master itself still converges onto the re-anchored routine (no twin)', async () => {
        await seedReanchoredRoutine();
        const terminalMaster = makeMaster(TERMINAL_ID, 'FREQ=WEEKLY;BYDAY=TH', '2026-08-27T14:00:00Z', { updated: '2026-08-31T09:00:00.000Z' });

        await importCalendarEvents(source, [terminalMaster], makeCtx());

        const onSeries = await routinesDAO.findArray({ user: USER, calendarEventId: 'chain-base', calendarIntegrationId: 'int-chain' });
        expect(onSeries).toHaveLength(1);
        const [tail] = onSeries;
        if (!tail) {
            throw new Error('expected the re-anchored routine to survive');
        }
        expect(tail._id).toBe('r-reanchored');
        expect(tail.active).toBe(true);
        expect(tail.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
    });

    /**
     * A SECOND "this and all following" split applied to the re-anchored series. GCal caps the
     * terminal `_R` link the routine is keyed to and mints a newer `_R` continuation. The one-row
     * shape must converge onto the new tail in place: no active twin, no dead series.
     */
    const RESPLIT_ID = 'chain-base_R20260904T140000';
    const cappedTerminal = () =>
        makeMaster(TERMINAL_ID, 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260903T235959Z', '2026-08-27T14:00:00Z', { updated: '2026-09-01T09:00:00.000Z' });
    const resplitTail = () => makeMaster(RESPLIT_ID, 'FREQ=WEEKLY;BYDAY=FR', '2026-09-04T14:00:00Z', { updated: '2026-09-01T09:00:00.000Z' });

    async function expectConvergedOnResplitTail(): Promise<void> {
        const onSeries = await routinesDAO.findArray({ user: USER, calendarEventId: 'chain-base', calendarIntegrationId: 'int-chain' });
        const active = onSeries.filter((routine) => routine.active);
        expect(active).toHaveLength(1);
        const [tail] = active;
        if (!tail) {
            throw new Error('expected exactly one active routine on the series');
        }
        expect(tail._id).toBe('r-reanchored');
        expect(tail.calendarRebasedEventId).toBe(RESPLIT_ID);
        expect(tail.rrule).toBe('FREQ=WEEKLY;BYDAY=FR');
        // No lineage-less twin: every other row on the series (if any) is an inactive capped segment.
        for (const other of onSeries.filter((routine) => routine._id !== 'r-reanchored')) {
            expect(other.active).toBe(false);
            expect(other.rrule).toContain('UNTIL=');
        }
    }

    it('REGRESSION: a re-split batch [capped terminal, new open _R tail] converges the re-anchored routine onto the new tail in place', async () => {
        await seedReanchoredRoutine();

        await importCalendarEvents(source, [cappedTerminal(), resplitTail()], makeCtx());
        await expectConvergedOnResplitTail();

        // The stale base re-reporting afterwards (an RSVP nudge) must not kill the converged tail.
        const cappedBase = makeMaster('chain-base', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260722T235959Z', '2025-10-06T14:00:00Z', {
            updated: '2026-09-01T10:00:00.000Z',
        });
        await importCalendarEvents(source, [cappedBase], makeCtx());
        await expectConvergedOnResplitTail();
    });

    it('REGRESSION: the new open _R tail arriving ALONE (out of order, before the cap) still converges without a twin', async () => {
        await seedReanchoredRoutine();

        await importCalendarEvents(source, [resplitTail()], makeCtx());
        await expectConvergedOnResplitTail();

        // The capped terminal lands in a later delta; it is a dead segment now and must not re-cap the tail.
        await importCalendarEvents(source, [cappedTerminal()], makeCtx());
        await expectConvergedOnResplitTail();
    });

    it('a cancelled BASE tombstone spares the re-anchored tail (deleting a dead segment must not kill the live series)', async () => {
        await seedReanchoredRoutine();
        const cancelledBase: GCalEvent = {
            id: 'chain-base',
            title: 'Chained Series',
            timeStart: '2025-10-06T14:00:00Z',
            timeEnd: '2025-10-06T15:00:00Z',
            updated: '2026-08-31T09:00:00.000Z',
            status: 'cancelled',
        };

        await importCalendarEvents(source, [cancelledBase], makeCtx());

        const tail = await loadRoutine('r-reanchored');
        expect(tail.active).toBe(true);
        expect(tail.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
    });
});
