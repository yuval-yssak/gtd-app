import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2e for cross-account "edit + move" of a routine. The server's reassignRoutine path applies the
// editRoutinePatch (title/rrule/template/etc.) to the persisted routine snapshot. Generated items
// are NOT transplanted — the source-leg delete's pushRoutineDeletion cascade trashes status='calendar'
// rows on the source account, and Bob's copy starts fresh from the next tick. We pin both halves
// here so a future refactor that re-introduces the transplant path fails loudly.

const DEV_SEED_ENTITY_URL = 'http://localhost:4000/dev/reassign/seed-entity';
const DEV_FIND_ENTITY_URL = 'http://localhost:4000/dev/reassign/find-entity';
const INBOX_URL = 'http://localhost:4173/inbox';

async function seedRoutineOnServer(userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = `seedr-${Math.random().toString(36).slice(2, 10)}`;
    const now = dayjs().toISOString();
    const doc = {
        _id: id,
        user: userId,
        title: 'Original routine',
        routineType: 'nextAction',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: { energy: 'medium' },
        active: true,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    const res = await fetch(DEV_SEED_ENTITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'routines', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed routine ${res.status}: ${await res.text()}`);
    }
    return id;
}

async function seedItemOnServer(userId: string, title: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
    const now = dayjs().toISOString();
    const doc = { _id: id, user: userId, status: 'nextAction', title, createdTs: now, updatedTs: now, ...overrides };
    const res = await fetch(DEV_SEED_ENTITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed item ${res.status}: ${await res.text()}`);
    }
    return id;
}

interface ServerRoutine {
    _id: string;
    user: string;
    title: string;
    rrule: string;
    routineType: string;
    template: Record<string, unknown>;
    active: boolean;
}

interface ServerItem {
    _id: string;
    user: string;
    routineId?: string;
}

async function fetchServerRoutine(entityId: string): Promise<ServerRoutine | null> {
    const res = await fetch(`${DEV_FIND_ENTITY_URL}?collection=routines&entityId=${entityId}`);
    if (!res.ok) {
        return null;
    }
    const body = (await res.json()) as { doc: ServerRoutine | null };
    return body.doc;
}

async function fetchServerItem(entityId: string): Promise<ServerItem | null> {
    const res = await fetch(`${DEV_FIND_ENTITY_URL}?collection=items&entityId=${entityId}`);
    if (!res.ok) {
        return null;
    }
    const body = (await res.json()) as { doc: ServerItem | null };
    return body.doc;
}

/** Server-generated items (routine seeding) have ids the test can't know — filter by owner + routine + status. */
async function fetchServerItemForRoutine(userId: string, routineId: string, status: string): Promise<(ServerItem & { status: string }) | null> {
    const res = await fetch(`${DEV_FIND_ENTITY_URL}?collection=items&user=${userId}&routineId=${routineId}&status=${status}`);
    if (!res.ok) {
        return null;
    }
    const body = (await res.json()) as { doc: (ServerItem & { status: string }) | null };
    return body.doc;
}

test.describe('RoutineDialog cross-account reassign — atomic edit + move', () => {
    // Each test scopes its /dev/reset to its unique stamped emails so concurrent specs in
    // other workers keep their session/user data.
    test('routine moves + title/rrule edits ride along; source-side generated items stay under fromUser', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `routine-edit-a-${stamp}@example.com`;
        const emailB = `routine-edit-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const routineId = await seedRoutineOnServer(active.userId, { title: 'Daily standup', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
            // Two generated items so we can prove the cascade leaves non-calendar rows alone and
            // the transplant-to-target path is gone (item1 nextAction, item2 done — neither is
            // status='calendar' so the cascade's trash-the-calendars sweep doesn't touch them).
            const item1 = await seedItemOnServer(active.userId, 'Standup gen 1', { routineId });
            const item2 = await seedItemOnServer(active.userId, 'Standup gen 2', { routineId, status: 'done' });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'routine',
                entityId: routineId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                editRoutinePatch: {
                    title: 'Renamed during move',
                    rrule: 'FREQ=DAILY;INTERVAL=1',
                    template: { energy: 'high', urgent: true },
                },
            });
            expect(result.ok).toBe(true);

            // Routine moved + edits applied.
            await expect.poll(async () => (await fetchServerRoutine(routineId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const movedRoutine = await fetchServerRoutine(routineId);
            expect(movedRoutine?.title).toBe('Renamed during move');
            expect(movedRoutine?.rrule).toBe('FREQ=DAILY;INTERVAL=1');
            expect(movedRoutine?.template).toEqual({ energy: 'high', urgent: true });

            // Generated items stay under fromUser with their routineId link intact — Bob starts fresh,
            // Alice keeps the history. The cascade only trashes status='calendar' rows.
            const sourceItem1 = await fetchServerItem(item1);
            const sourceItem2 = await fetchServerItem(item2);
            expect(sourceItem1?.user).toBe(active.userId);
            expect(sourceItem1?.routineId).toBe(routineId);
            expect(sourceItem2?.user).toBe(active.userId);
            expect(sourceItem2?.routineId).toBe(routineId);
        });
    });

    test('paused routine: editRoutinePatch.active=true resumes it on the target account', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `routine-resume-a-${stamp}@example.com`;
        const emailB = `routine-resume-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const routineId = await seedRoutineOnServer(active.userId, { active: false, title: 'Paused routine' });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'routine',
                entityId: routineId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                editRoutinePatch: { active: true },
            });
            expect(result.ok).toBe(true);

            await expect.poll(async () => (await fetchServerRoutine(routineId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const moved = await fetchServerRoutine(routineId);
            expect(moved?.active).toBe(true);
        });
    });

    test('moved nextAction routine seeds its first item under the target account', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `routine-seed-a-${stamp}@example.com`;
        const emailB = `routine-seed-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const routineId = await seedRoutineOnServer(active.userId, { title: 'Daily check', rrule: 'FREQ=DAILY' });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'routine',
                entityId: routineId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
            });
            expect(result.ok).toBe(true);

            // The reassign must seed the first nextAction occurrence server-side — the SSE pull
            // path never runs the client materialize backstop, so without seeding the routine
            // would sit itemless on the target until an app reload.
            await expect
                .poll(async () => (await fetchServerItemForRoutine(secondary.userId, routineId, 'nextAction'))?.user, { timeout: 5_000 })
                .toBe(secondary.userId);
        });
    });

    test('moved calendar routine seeds horizon items under the target account', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `routine-calseed-a-${stamp}@example.com`;
        const emailB = `routine-calseed-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const routineId = await seedRoutineOnServer(active.userId, {
                title: 'Morning swim',
                routineType: 'calendar',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '07:30', duration: 45 },
            });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'routine',
                entityId: routineId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
            });
            expect(result.ok).toBe(true);

            // Calendar routines have no client-side generation backstop at all — the server-side
            // horizon fill on reassign is the only thing standing between the target and an
            // items-less routine.
            await expect
                .poll(async () => (await fetchServerItemForRoutine(secondary.userId, routineId, 'calendar'))?.user, { timeout: 5_000 })
                .toBe(secondary.userId);
        });
    });
});
