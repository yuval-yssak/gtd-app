import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// DST nights are where a fixed-24h scheduler is provably wrong by an hour: the day clock instead
// targets the NEXT LOCAL MIDNIGHT, so a 25-hour fall-back day and a 23-hour spring-forward day
// both roll exactly at 00:00 wall time. Browser context pinned to America/New_York; the faked
// instants are the DST-transition nights (fall back 2026-11-01, spring forward 2027-03-14).
//
// Both tests arm the clock BEFORE the 02:00 transition, so the armed timeout must account for the
// skipped/repeated hour. fastForward covers the bulk of the day without replaying every interval
// tick; the final runFor crosses the actual midnight and fires the reveal.

test.describe('Tickler DST-night rollover (America/New_York)', () => {
    test('fall-back night: the 25-hour day still reveals at local midnight, not an hour early', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `tickler-dst-fall-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const captured = await gtd.collect(page, 'Rake the leaves');
                await gtd.clarifyToNextAction(page, captured, { ignoreBefore: '2026-11-02' });
                await gtd.flush(page);

                // 00:30 EDT on Nov 1 2026 — 1.5h before the clocks fall back. Midnight Nov 2 is
                // 24.5 real hours away (the day is 25h long).
                await page.clock.install({ time: new Date('2026-11-01T04:30:00Z') });
                await page.goto('/next-actions');
                await expect(page.getByRole('heading', { name: 'Next Actions' })).toBeVisible();
                const row = page.getByTestId('nextActionItemRow').filter({ hasText: 'Rake the leaves' });
                await expect(row).toHaveCount(0);

                // +24h real = 23:30 EST, still Nov 1 — a fixed-24h scheduler has already "used up"
                // its day here; the item must NOT have appeared.
                await page.clock.fastForward(24 * 60 * 60 * 1000);
                await expect(row).toHaveCount(0);

                // 23:59 EST — one minute out, still hidden (pins the boundary to the minute, not
                // merely "some time in the last hour").
                await page.clock.runFor(29 * 60 * 1000);
                await expect(row).toHaveCount(0);

                // Crossing 00:00 EST Nov 2 — the midnight-targeted timer fires now.
                await page.clock.runFor(2 * 60 * 1000);
                await expect(row).toBeVisible();
            },
            { timezoneId: 'America/New_York' },
        );
    });

    test('spring-forward night: the 23-hour day reveals at local midnight, not an hour late', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `tickler-dst-spring-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const captured = await gtd.collect(page, 'Plant tomato seedlings');
                await gtd.clarifyToNextAction(page, captured, { ignoreBefore: '2027-03-15' });
                await gtd.flush(page);

                // 00:30 EST on Mar 14 2027 — 1.5h before the clocks spring forward. Midnight
                // Mar 15 is only 22.5 real hours away (the day is 23h long).
                await page.clock.install({ time: new Date('2027-03-14T05:30:00Z') });
                await page.goto('/next-actions');
                await expect(page.getByRole('heading', { name: 'Next Actions' })).toBeVisible();
                const row = page.getByTestId('nextActionItemRow').filter({ hasText: 'Plant tomato seedlings' });
                await expect(row).toHaveCount(0);

                // +22h real = 23:30 EDT, still Mar 14 — not yet.
                await page.clock.fastForward(22 * 60 * 60 * 1000);
                await expect(row).toHaveCount(0);

                // 23:59 EDT — one minute out, still hidden.
                await page.clock.runFor(29 * 60 * 1000);
                await expect(row).toHaveCount(0);

                // Crossing 00:00 EDT Mar 15 — a fixed-24h scheduler would still be an hour out
                // (firing at 00:30+24h = 01:30 wall time); the reveal must land now.
                await page.clock.runFor(2 * 60 * 1000);
                await expect(row).toBeVisible();
            },
            { timezoneId: 'America/New_York' },
        );
    });
});
