import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

dayjs.extend(utc);
dayjs.extend(timezone);

// The server half of the tickler day-boundary fix, end-to-end: the client reports its IANA
// timezone on every bootstrap/pull, and server-side routine advancement (public API /complete)
// stamps the next item on the USER-local calendar day — not the server's. The API server runs
// under TZ=UTC (playwright.config.ts webServer — Cloud Run parity), while the browser context is
// pinned to a zone whose local date currently DISAGREES with UTC, so a server that stamped its
// own day would produce a date one off from the client's.
//
const API_URL = 'http://localhost:4000';

// Zone choice is dynamic: Kiritimati (UTC+14) reads tomorrow from 10:00Z onward; Pago Pago
// (UTC-11) reads yesterday until 11:00Z. Between them, at least one disagrees with UTC at any
// instant (both do in the 10:00–11:00Z window), so the parity assertion is never vacuous.
// The >= 10 threshold is also flake-proof, not just non-vacuous: Kiritimati's local midnight is
// exactly 10:00Z (its window's start edge) and Pago Pago's is 11:00Z (outside its window), so
// neither selection window CONTAINS a local-midnight crossing — expectedNextDate below cannot
// drift from the stamps mid-test. Changing the threshold can silently break that property.
function timezoneDisagreeingWithUtcNow(): string {
    return dayjs.utc().hour() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
}

test.describe('Tickler timezone parity — client stamps vs server stamps', () => {
    test('completing sibling routine items via the client and via the public API stamps the same user-local date', async ({ browser }) => {
        const timezoneId = timezoneDisagreeingWithUtcNow();
        const email = `tickler-tz-parity-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(
            browser,
            email,
            async (page) => {
                await gtd.createRoutine(page, { title: 'Parity client', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: true });
                await gtd.createRoutine(page, { title: 'Parity server', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: true });
                await gtd.materializePendingNextActionRoutines(page);
                await gtd.flush(page);
                // The pull reports the browser's timezone — after this the server's
                // deviceSyncState row carries it and resolveUserTimezone returns it.
                await gtd.pull(page);

                const routines = await gtd.listRoutines(page);
                const clientRoutine = routines.find((r) => r.title === 'Parity client');
                const serverRoutine = routines.find((r) => r.title === 'Parity server');
                if (!clientRoutine || !serverRoutine) throw new Error('expected both parity routines');
                const items = await gtd.listItems(page);
                const clientItem = items.find((i) => i.routineId === clientRoutine._id && i.status === 'nextAction');
                const serverItem = items.find((i) => i.routineId === serverRoutine._id && i.status === 'nextAction');
                if (!clientItem || !serverItem) throw new Error('expected one open item per parity routine');

                // Computed before either completion so a local midnight can't slip between the
                // expectation and the stamps.
                const expectedNextDate = dayjs().tz(timezoneId).add(1, 'day').format('YYYY-MM-DD');

                // Client half: same code path as the Mark done button (disposal → createNextRoutineItem).
                await gtd.clarifyToDone(page, clientItem);
                await gtd.flush(page);

                // Server half: a public-API bearer completion — advancement runs in
                // routineItemGeneration.ts against the REPORTED timezone, on a TZ=UTC server.
                const mint = await page.context().request.post(`${API_URL}/account/tokens`, {
                    data: { label: 'tz-parity', scopes: ['items.read', 'items.write'] },
                });
                expect(mint.ok()).toBe(true);
                const { plaintext } = (await mint.json()) as { plaintext: string };
                const complete = await page.context().request.post(`${API_URL}/v1/items/${serverItem._id}/complete`, {
                    headers: { Authorization: `Bearer ${plaintext}` },
                });
                expect(complete.ok()).toBe(true);

                await gtd.pull(page);
                const after = await gtd.listItems(page);
                const nextClient = after.find((i) => i.routineId === clientRoutine._id && i.status === 'nextAction');
                const nextServer = after.find((i) => i.routineId === serverRoutine._id && i.status === 'nextAction');
                if (!nextClient || !nextServer) throw new Error('expected a successor item per parity routine');

                // The load-bearing assertion: both halves of the pipeline land on the SAME
                // user-local calendar day — pinned to the literal expected date so an
                // equal-but-both-wrong pair (e.g. both stamping the UTC day) still fails.
                expect(nextClient.expectedBy).toBe(expectedNextDate);
                expect(nextServer.expectedBy).toBe(expectedNextDate);
                expect(nextClient.ignoreBefore).toBe(expectedNextDate);
                expect(nextServer.ignoreBefore).toBe(expectedNextDate);
            },
            { timezoneId },
        );
    });
});
