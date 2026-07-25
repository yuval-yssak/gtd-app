import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withTwoAccountsOnOneDevice } from './helpers/context';

// The item-editor work-context/people pickers must offer only the OWNING account's entities.
// In the merged multi-account view each account owns its own "anywhere" context, and before the
// owner-scoping fix the /item/:id page fed the unfiltered all* sets into the picker — rendering
// two indistinguishable "anywhere" chips and allowing cross-account tagging. Already-assigned
// cross-account tags must still render (resolved via the unfiltered sets), not silently vanish.

/** Seeds a StoredWorkContext directly into the device's IDB under the supplied userId. */
async function seedWorkContextForUser(page: Page, userId: string, name: string): Promise<string> {
    return page.evaluate(
        ({ userId, name }) => {
            type IDBWorkContext = { _id: string; userId: string; name: string; createdTs: string; updatedTs: string };
            type DBHandle = { put(store: 'workContexts', value: IDBWorkContext): Promise<unknown> };
            const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
            const id = `seed-ctx-${Math.random().toString(36).slice(2, 10)}`;
            const now = new Date().toISOString();
            return dbHandle.put('workContexts', { _id: id, userId, name, createdTs: now, updatedTs: now }).then(() => id);
        },
        { userId, name },
    );
}

/** Seeds a nextAction StoredItem directly into IDB, optionally pre-tagged with work contexts. */
async function seedNextActionForUser(page: Page, userId: string, title: string, workContextIds: string[] = []): Promise<string> {
    return page.evaluate(
        ({ userId, title, workContextIds }) => {
            type IDBItem = { _id: string; userId: string; status: string; title: string; createdTs: string; updatedTs: string; workContextIds?: string[] };
            type DBHandle = { put(store: 'items', value: IDBItem): Promise<unknown> };
            const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
            const id = `seed-item-${Math.random().toString(36).slice(2, 10)}`;
            const now = new Date().toISOString();
            const item: IDBItem = { _id: id, userId, status: 'nextAction', title, createdTs: now, updatedTs: now };
            if (workContextIds.length > 0) {
                item.workContextIds = workContextIds;
            }
            return dbHandle.put('items', item).then(() => id);
        },
        { userId, title, workContextIds },
    );
}

/** Seeds a StoredPerson directly into the device's IDB under the supplied userId. */
async function seedPersonForUser(page: Page, userId: string, name: string): Promise<string> {
    return page.evaluate(
        ({ userId, name }) => {
            type IDBPerson = { _id: string; userId: string; name: string; createdTs: string; updatedTs: string };
            type DBHandle = { put(store: 'people', value: IDBPerson): Promise<unknown> };
            const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
            const id = `seed-person-${Math.random().toString(36).slice(2, 10)}`;
            const now = new Date().toISOString();
            return dbHandle.put('people', { _id: id, userId, name, createdTs: now, updatedTs: now }).then(() => id);
        },
        { userId, name },
    );
}

/** Seeds a waitingFor StoredItem directly into IDB, blocked on the supplied person. */
async function seedWaitingForForUser(page: Page, userId: string, title: string, waitingForPersonId: string): Promise<string> {
    return page.evaluate(
        ({ userId, title, waitingForPersonId }) => {
            type IDBItem = { _id: string; userId: string; status: string; title: string; createdTs: string; updatedTs: string; waitingForPersonId: string };
            type DBHandle = { put(store: 'items', value: IDBItem): Promise<unknown> };
            const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
            const id = `seed-item-${Math.random().toString(36).slice(2, 10)}`;
            const now = new Date().toISOString();
            return dbHandle.put('items', { _id: id, userId, status: 'waitingFor', title, createdTs: now, updatedTs: now, waitingForPersonId }).then(() => id);
        },
        { userId, title, waitingForPersonId },
    );
}

/** Seeds a minimal nextAction StoredRoutine directly into IDB under the supplied userId. */
async function seedRoutineForUser(page: Page, userId: string, title: string): Promise<string> {
    return page.evaluate(
        ({ userId, title }) => {
            type IDBRoutine = {
                _id: string;
                userId: string;
                title: string;
                routineType: 'nextAction';
                rrule: string;
                template: Record<string, never>;
                active: boolean;
                createdTs: string;
                updatedTs: string;
            };
            type DBHandle = { put(store: 'routines', value: IDBRoutine): Promise<unknown> };
            const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
            const id = `seed-routine-${Math.random().toString(36).slice(2, 10)}`;
            const now = new Date().toISOString();
            const routine: IDBRoutine = {
                _id: id,
                userId,
                title,
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                createdTs: now,
                updatedTs: now,
            };
            return dbHandle.put('routines', routine).then(() => id);
        },
        { userId, title },
    );
}

test.describe('editor picker owner scoping', () => {
    test('item-page picker shows only the owner account\'s contexts when both accounts have an "anywhere"', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `picker-scope-a-${stamp}@example.com`;
        const emailB = `picker-scope-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await seedWorkContextForUser(page, active.userId, 'anywhere');
            await seedWorkContextForUser(page, secondary.userId, 'anywhere');
            const itemId = await seedNextActionForUser(page, active.userId, 'A — scoped picker');

            await page.goto(`/item/${itemId}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page.getByLabel('Title')).toHaveValue('A — scoped picker');

            // Exactly one "anywhere" chip — the owner account's. Account B's twin stays out.
            await expect(page.getByTestId('editorWorkContextChip')).toHaveText(['anywhere']);
        });
    });

    test('a pre-existing cross-account tag still renders while unassigned foreign contexts stay hidden', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `picker-stray-a-${stamp}@example.com`;
        const emailB = `picker-stray-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await seedWorkContextForUser(page, active.userId, 'anywhere');
            await seedWorkContextForUser(page, secondary.userId, 'anywhere');
            const strayId = await seedWorkContextForUser(page, secondary.userId, 'b office');
            const itemId = await seedNextActionForUser(page, active.userId, 'A — stray tag', [strayId]);

            await page.goto(`/item/${itemId}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            // Owner's "anywhere" + the assigned cross-account "b office" render; B's unassigned
            // "anywhere" twin does not (chips are alphabetical via sortByName).
            await expect(page.getByTestId('editorWorkContextChip')).toHaveText(['anywhere', 'b office']);
            // The stray renders as selected (filled), so the user can read and remove it.
            await expect(page.getByTestId('editorWorkContextChip').filter({ hasText: 'b office' })).toHaveClass(/MuiChip-filled/);
        });
    });

    test("routine-page template picker is scoped to the routine's owning account", async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `picker-routine-a-${stamp}@example.com`;
        const emailB = `picker-routine-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await seedWorkContextForUser(page, active.userId, 'anywhere');
            await seedWorkContextForUser(page, secondary.userId, 'anywhere');
            const routineId = await seedRoutineForUser(page, active.userId, 'A — scoped routine picker');

            await page.goto(`/routine/${routineId}`);
            await expect(page.getByTestId('routinePageWrapper')).toBeVisible();
            await expect(page.getByLabel('Title')).toHaveValue('A — scoped routine picker');

            await expect(page.getByTestId('routineTemplateWorkContextChip')).toHaveText(['anywhere']);
        });
    });

    test("a waitingFor item blocked on a cross-account person still shows that person's name", async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `picker-wf-a-${stamp}@example.com`;
        const emailB = `picker-wf-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const foreignPersonId = await seedPersonForUser(page, secondary.userId, 'Bella (account B)');
            const itemId = await seedWaitingForForUser(page, active.userId, 'A — waiting on B person', foreignPersonId);

            await page.goto(`/item/${itemId}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            // The Select must resolve the foreign person's name — a blank select would silently
            // drop the reference on the next save.
            await expect(page.getByLabel('Waiting for (optional)')).toHaveText('Bella (account B)');
        });
    });
});
