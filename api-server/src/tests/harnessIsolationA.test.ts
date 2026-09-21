import dayjs from 'dayjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';

// Pair with harnessIsolationB.test.ts: both load the SAME logical database name, so only the
// per-file suffix (mainLoader.namespaceTestDB) keeps each file's canary out of the other's
// collections. Each file writes its own canary and looks for the other's, so whichever of the two
// runs second — on the same worker or not — is the one that would catch a shared database.
beforeAll(async () => {
    await loadDataAccess('gtd_test_isolation');
});

afterAll(async () => {
    await closeDataAccess();
});

it("writes a canary only this file can see, and never sees the other file's", async () => {
    const now = dayjs().toISOString();
    await itemsDAO.insertOne({ _id: 'cross-file-canary-A', user: 'user-isolation', status: 'inbox', title: 'canary', createdTs: now, updatedTs: now });
    expect(await itemsDAO.findOne({ _id: 'cross-file-canary-A' })).not.toBeNull();
    expect(await itemsDAO.findOne({ _id: 'cross-file-canary-B' })).toBeNull();
});
