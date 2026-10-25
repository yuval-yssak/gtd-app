// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import { type ReactNode, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSyncConfigsBundle } from '../api/calendarApi';
import * as calendarApi from '../api/calendarApi';
import { _resetCalendarOptionsCacheForTests, CALENDAR_OPTIONS_RETRY_AFTER_FAILURE_MS, useCalendarOptions } from '../hooks/useCalendarOptions';

const WORK_CALENDAR: AccountSyncConfigsBundle = {
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
            ],
        },
    ],
};

function OptionCount({ renderTick }: { renderTick: number }) {
    const { options } = useCalendarOptions();
    return (
        <p>
            {options.length} calendars, render {renderTick}
        </p>
    );
}

function Reader({ renderTick, fallback = <p>loading</p> }: { renderTick: number; fallback?: ReactNode }) {
    return (
        <Suspense fallback={fallback}>
            <OptionCount renderTick={renderTick} />
        </Suspense>
    );
}

/** Mounts a reader whose first request has already failed and settled on no options. */
async function mountAfterFailure(fallback?: ReactNode) {
    const view = { current: null as ReturnType<typeof render> | null };
    // Awaited act: React only retries a suspended render inside an act scope in tests.
    await act(async () => {
        view.current = render(<Reader renderTick={1} fallback={fallback} />);
    });
    if (!view.current) throw new Error('expected the reader to mount');
    expect(screen.getByText('0 calendars, render 1')).toBeTruthy();
    return view.current;
}

beforeEach(() => {
    _resetCalendarOptionsCacheForTests();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// A use() reader over a cache that drops itself on failure re-suspends on every render — the
// editor that reads the options then never mounts, and the request repeats forever.
describe('useCalendarOptions under Suspense', () => {
    it('settles on an empty list when the round-trip fails, with a single request', async () => {
        const spy = vi.spyOn(calendarApi, 'getAllSyncConfigs').mockRejectedValue(new Error('401'));
        await mountAfterFailure();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('retries in the background after the window: a mounted reader never falls back to loading', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        let resolveRetry: (bundles: AccountSyncConfigsBundle[]) => void = () => {};
        const retry = new Promise<AccountSyncConfigsBundle[]>((resolve) => {
            resolveRetry = resolve;
        });
        const spy = vi.spyOn(calendarApi, 'getAllSyncConfigs').mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(retry);
        const view = await mountAfterFailure();

        vi.setSystemTime(
            dayjs()
                .add(CALENDAR_OPTIONS_RETRY_AFTER_FAILURE_MS + 1, 'ms')
                .valueOf(),
        );
        await act(async () => view.rerender(<Reader renderTick={2} />));
        // The retry is in flight, but the reader keeps showing the settled result — no loading flash.
        expect(spy).toHaveBeenCalledTimes(2);
        expect(screen.queryByText('loading')).toBeNull();
        expect(screen.getByText('0 calendars, render 2')).toBeTruthy();

        // Once the retry lands, the next render reads the fresh options.
        await act(async () => resolveRetry([WORK_CALENDAR]));
        await act(async () => view.rerender(<Reader renderTick={3} />));
        expect(screen.queryByText('loading')).toBeNull();
        expect(screen.getByText('1 calendars, render 3')).toBeTruthy();
    });

    // The final-state check above cannot see a one-tick fallback, so this one counts fallback renders.
    it('swaps in the retried options without suspending the reader even once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.spyOn(calendarApi, 'getAllSyncConfigs').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([WORK_CALENDAR]);
        const fallbackRenders = { count: 0 };
        const CountingFallback = () => {
            fallbackRenders.count += 1;
            return <p>loading</p>;
        };
        const view = await mountAfterFailure(<CountingFallback />);
        const rendersBeforeRetry = fallbackRenders.count;

        vi.setSystemTime(
            dayjs()
                .add(CALENDAR_OPTIONS_RETRY_AFTER_FAILURE_MS + 1, 'ms')
                .valueOf(),
        );
        await act(async () => view.rerender(<Reader renderTick={2} fallback={<CountingFallback />} />));
        await act(async () => view.rerender(<Reader renderTick={3} fallback={<CountingFallback />} />));

        expect(screen.getByText('1 calendars, render 3')).toBeTruthy();
        expect(fallbackRenders.count).toBe(rendersBeforeRetry);
    });
});
