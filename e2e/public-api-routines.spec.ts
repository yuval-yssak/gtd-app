import { type APIRequestContext, type Browser, type BrowserContext, expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const API_URL = 'http://localhost:4000';

/**
 * Phase 4 e2e for /v1/routines and the composite gestures (pause/resume/split). Drives a
 * routine through its full lifecycle via the bearer-only path. GCal master-event lifecycle
 * (UNTIL on pause, new tail master on split) is intentionally NOT asserted here — it's covered
 * by the manually-run smoke tests under `e2e/gcal-sync-smoke/`.
 */

interface Plaintext {
    id: string;
    plaintext: string;
}

async function mintRoutineToken(request: APIRequestContext): Promise<Plaintext> {
    const res = await request.post(`${API_URL}/account/tokens`, {
        data: { label: 'phase4-routines', scopes: ['routines.read', 'routines.write'] },
    });
    expect(res.status()).toBe(200);
    return (await res.json()) as Plaintext;
}

async function withBearerOnlyContext(browser: Browser, fn: (ctx: BrowserContext) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
        await fn(ctx);
    } finally {
        await ctx.close();
    }
}

test.describe('public /v1/routines lifecycle', () => {
    test('create → pause → resume → split → delete (cascade marks the head capped)', async ({ browser }) => {
        const email = `public-api-routines-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const { plaintext } = await mintRoutineToken(page.context().request);

            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}` } };

                // 1. Create a routine.
                const create = await apiContext.request.post(`${API_URL}/v1/routines`, {
                    ...auth,
                    data: { title: 'Daily review', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: { notes: 'Review inbox' }, active: true },
                });
                expect(create.status()).toBe(201);
                const created = (await create.json()) as { _id: string; title: string; active: boolean };
                const id = created._id;
                expect(created.active).toBe(true);

                // 2. Pause — flips active=false.
                const pause = await apiContext.request.post(`${API_URL}/v1/routines/${id}/pause`, auth);
                expect(pause.status()).toBe(200);
                const paused = (await pause.json()) as { active: boolean };
                expect(paused.active).toBe(false);

                // 3. Resume — flips active=true and stamps a tomorrow startDate.
                const resume = await apiContext.request.post(`${API_URL}/v1/routines/${id}/resume`, auth);
                expect(resume.status()).toBe(200);
                const resumed = (await resume.json()) as { active: boolean; startDate?: string };
                expect(resumed.active).toBe(true);
                expect(resumed.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

                // 4. Split at 2099-06-01 with edited title — produces a new tail routine; head is capped + active=false.
                const split = await apiContext.request.post(`${API_URL}/v1/routines/${id}/split`, {
                    ...auth,
                    data: { splitDate: '2099-06-01', tailEdits: { title: 'Daily review (new cadence)', rrule: 'FREQ=WEEKLY' } },
                });
                expect(split.status()).toBe(201);
                const splitBody = (await split.json()) as {
                    head: { _id: string; rrule: string; active: boolean };
                    tail: { _id: string; title: string; rrule: string; splitFromRoutineId?: string };
                };
                expect(splitBody.head._id).toBe(id);
                expect(splitBody.head.active).toBe(false);
                expect(splitBody.head.rrule).toMatch(/UNTIL=20990531T235959Z/);
                expect(splitBody.tail.title).toBe('Daily review (new cadence)');
                expect(splitBody.tail.rrule).toBe('FREQ=WEEKLY');
                expect(splitBody.tail.splitFromRoutineId).toBe(id);

                // 5. DELETE the tail — idempotent, returns 200 alreadyDeleted on the second call.
                const del1 = await apiContext.request.delete(`${API_URL}/v1/routines/${splitBody.tail._id}`, auth);
                expect(del1.status()).toBe(200);
                const del2 = await apiContext.request.delete(`${API_URL}/v1/routines/${splitBody.tail._id}`, auth);
                expect(del2.status()).toBe(200);
                expect(((await del2.json()) as { alreadyDeleted: boolean }).alreadyDeleted).toBe(true);
            });
        });
    });

    test('routines.read-only token gets 403 on pause/resume/split (atomic — no partial writes)', async ({ browser }) => {
        const email = `public-api-routines-readonly-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const session = page.context().request;
            // Mint a write token to seed a routine, then a read-only token to attempt the gestures.
            const writeRes = await session.post(`${API_URL}/account/tokens`, { data: { label: 'writer', scopes: ['routines.read', 'routines.write'] } });
            const { plaintext: writer } = (await writeRes.json()) as Plaintext;
            const readOnlyRes = await session.post(`${API_URL}/account/tokens`, { data: { label: 'reader', scopes: ['routines.read'] } });
            const { plaintext: reader } = (await readOnlyRes.json()) as Plaintext;

            await withBearerOnlyContext(browser, async (apiContext) => {
                const create = await apiContext.request.post(`${API_URL}/v1/routines`, {
                    headers: { Authorization: `Bearer ${writer}` },
                    data: { title: 'r', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: true },
                });
                const { _id } = (await create.json()) as { _id: string };

                const auth = { headers: { Authorization: `Bearer ${reader}` } };
                const pauseRes = await apiContext.request.post(`${API_URL}/v1/routines/${_id}/pause`, auth);
                expect(pauseRes.status()).toBe(403);
                const splitRes = await apiContext.request.post(`${API_URL}/v1/routines/${_id}/split`, { ...auth, data: { splitDate: '2099-06-01' } });
                expect(splitRes.status()).toBe(403);
            });
        });
    });
});
