import type { Page } from '@playwright/test';

// Direct-IDB seeding for multi-account specs: rows are written under an arbitrary userId via the
// window.__gtd dev harness, bypassing the active-account-based `__gtd.collect` path so specs
// don't have to pivot Better Auth sessions just to materialize another account's data.

/** Seeds a StoredWorkContext directly into the device's IDB under the supplied userId. */
export async function seedWorkContextForUser(page: Page, userId: string, name: string): Promise<string> {
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

/** Seeds a StoredPerson directly into the device's IDB under the supplied userId. */
export async function seedPersonForUser(page: Page, userId: string, name: string): Promise<string> {
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

/** Seeds a nextAction StoredItem directly into IDB, optionally pre-tagged with work contexts. */
export async function seedNextActionForUser(page: Page, userId: string, title: string, workContextIds: string[] = []): Promise<string> {
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

/** Seeds a waitingFor StoredItem directly into IDB, blocked on the supplied person. */
export async function seedWaitingForForUser(page: Page, userId: string, title: string, waitingForPersonId: string): Promise<string> {
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
export async function seedRoutineForUser(page: Page, userId: string, title: string): Promise<string> {
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
