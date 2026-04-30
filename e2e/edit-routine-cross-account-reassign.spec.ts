import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2e for cross-account "edit + move" of a routine + its generated items. Mirrors the item spec —
// the server's reassignRoutine path applies the editRoutinePatch (title/rrule/template/etc.) to
// the persisted routine snapshot and reassignGeneratedItems moves every generated item with it.

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

test.describe('RoutineDialog cross-account reassign — atomic edit + move', () => {
    test.beforeEach(async () => {
        await fetch('http://localhost:4000/dev/reset', { method: 'DELETE' });
    });

    test('routine + generated items move together; title/rrule edits ride along; routineId link survives', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `routine-edit-a-${stamp}@example.com`;
        const emailB = `routine-edit-b-${stamp}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const routineId = await seedRoutineOnServer(active.userId, { title: 'Daily standup', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
            // Two generated items so reassignGeneratedItems has something to move.
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

            // Generated items follow with their routineId link intact.
            const movedItem1 = await fetchServerItem(item1);
            const movedItem2 = await fetchServerItem(item2);
            expect(movedItem1?.user).toBe(secondary.userId);
            expect(movedItem1?.routineId).toBe(routineId);
            expect(movedItem2?.user).toBe(secondary.userId);
            expect(movedItem2?.routineId).toBe(routineId);
        });
    });

    test('paused routine: editRoutinePatch.active=true resumes it on the target account', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `routine-resume-a-${stamp}@example.com`;
        const emailB = `routine-resume-b-${stamp}@example.com`;
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
});
