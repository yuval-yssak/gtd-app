// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { IDBPDatabase } from 'idb';
import { type ReactNode, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSyncConfigsBundle } from '../api/calendarApi';
import {
    _resetCalendarOptionsCacheForTests,
    CALENDAR_OPTIONS_FETCH_DEADLINE_MS,
    refreshCalendarOptions,
    useCalendarOptions,
} from '../hooks/useCalendarOptions';
import type { CalendarOption, MyDB } from '../types/MyDB';
import { openTestDB, seedAccountOnDevice } from './openTestDB';

const STORED_WORK_CALENDAR: CalendarOption = {
    configId: 'cfg-A1',
    integrationId: 'int-A',
    userId: 'user-A',
    accountEmail: 'a@example.com',
    displayName: 'Work',
    isDefault: true,
};

const FETCHED_BUNDLE: AccountSyncConfigsBundle = {
    userId: 'user-A',
    accountEmail: 'a@example.com',
    integrations: [
        {
            _id: 'int-A',
            provider: 'google',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
            syncConfigs: [
                {
                    _id: 'cfg-A1',
                    integrationId: 'int-A',
                    calendarId: 'cal-A1',
                    displayName: 'Work',
                    isDefault: true,
                    enabled: true,
                    user: 'user-A',
                    createdTs: '2026-01-01T00:00:00.000Z',
                    updatedTs: '2026-01-01T00:00:00.000Z',
                },
                {
                    _id: 'cfg-A2',
                    integrationId: 'int-A',
                    calendarId: 'cal-A2',
                    displayName: 'Family',
                    isDefault: false,
                    enabled: true,
                    user: 'user-A',
                    createdTs: '2026-01-01T00:00:00.000Z',
                    updatedTs: '2026-01-01T00:00:00.000Z',
                },
            ],
        },
    ],
};

function CalendarNames({ db }: { db: IDBPDatabase<MyDB> }) {
    const { options } = useCalendarOptions(db);
    return <p>calendars: {options.map((option) => option.displayName).join(', ') || 'none'}</p>;
}

/** Counts fallback renders: a background refresh must never blank a mounted editor. */
function mountReader(db: IDBPDatabase<MyDB>) {
    const fallbackRenders = { count: 0 };
    const Fallback = (): ReactNode => {
        fallbackRenders.count += 1;
        return <p>loading</p>;
    };
    render(
        <Suspense fallback={<Fallback />}>
            <CalendarNames db={db} />
        </Suspense>,
    );
    return fallbackRenders;
}

/** A network that never answers, but honours an abort the way the browser's fetch does. */
function stubHangingFetch() {
    const fetchSpy = vi.fn(
        (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
}

function stubFetchAnswering(bundles: AccountSyncConfigsBundle[]) {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(bundles), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
}

async function storeCalendars(options: CalendarOption[]) {
    await db.put('calendarOptions', { userId: 'user-A', accountEmail: 'a@example.com', options, fetchedTs: '2026-01-01T00:00:00.000Z' });
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    _resetCalendarOptionsCacheForTests();
    db = await openTestDB();
    await seedAccountOnDevice(db, 'user-A');
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    db.close();
});

describe('useCalendarOptions', () => {
    it('renders the calendars stored on the device while the network never answers', async () => {
        await storeCalendars([STORED_WORK_CALENDAR]);
        stubHangingFetch();
        void refreshCalendarOptions(db);

        await act(async () => {
            mountReader(db);
        });

        expect(await screen.findByText('calendars: Work')).toBeTruthy();
    });

    it('stores a refreshed list and swaps it into a mounted reader without falling back', async () => {
        const fallbackRenders = await act(async () => mountReader(db));
        expect(await screen.findByText('calendars: none')).toBeTruthy();
        const fallbackRendersBeforeRefresh = fallbackRenders.count;
        stubFetchAnswering([FETCHED_BUNDLE]);

        await act(async () => refreshCalendarOptions(db));

        expect(screen.getByText('calendars: Work, Family')).toBeTruthy();
        expect(fallbackRenders.count).toBe(fallbackRendersBeforeRefresh);
        expect((await db.get('calendarOptions', 'user-A'))?.options.map((option) => option.configId)).toEqual(['cfg-A1', 'cfg-A2']);
    });

    it('keeps the stored calendars when a refresh fails', async () => {
        await storeCalendars([STORED_WORK_CALENDAR]);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('down', { status: 503 })),
        );

        await act(async () => {
            mountReader(db);
        });
        await act(async () => refreshCalendarOptions(db));

        expect(screen.getByText('calendars: Work')).toBeTruthy();
        expect((await db.get('calendarOptions', 'user-A'))?.options).toEqual([STORED_WORK_CALENDAR]);
    });

    it('gives up on a request that never answers, so the next refresh can try again', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const fetchSpy = stubHangingFetch();

        const firstRefresh = refreshCalendarOptions(db);
        await vi.advanceTimersByTimeAsync(CALENDAR_OPTIONS_FETCH_DEADLINE_MS);
        await firstRefresh;
        void refreshCalendarOptions(db);

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('shares one request between overlapping refreshes', async () => {
        const fetchSpy = stubHangingFetch();

        void refreshCalendarOptions(db);
        void refreshCalendarOptions(db);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
