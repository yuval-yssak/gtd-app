import * as fs from 'node:fs/promises';
import type { Download, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Reaped-device recovery flow. When the server's stale-device reaper deletes a device's
// deviceSyncState row, the device's next /sync/pull gets 409 {bootstrapRequired:true}:
//   - Case 1 (empty offline queue): a blocking dialog appears with a spinner and the client
//     auto-runs a full bootstrap — no user choice.
//   - Case 2 (queued offline ops): the client probes /sync/device-status BEFORE flushing, and
//     `registered:false` opens a blocking choice dialog: push / discard / export.
// The reap is simulated with the dev-only POST /dev/reap-device endpoint (test-side fetch, so
// page-level request interception never affects it).

const API_URL = 'http://localhost:4000';
const SYNC_GLOB = '**/sync/**';
const RAW_JSON_SEPARATOR = '--- RAW JSON ---';

/** Deletes the server-side deviceSyncState row for this page's device + user, simulating the stale-device reaper. */
async function reapDevice(page: Page, email: string): Promise<void> {
    const deviceId = await gtd.getDeviceId(page);
    const res = await fetch(`${API_URL}/dev/reap-device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, email }),
    });
    if (!res.ok) {
        throw new Error(`dev/reap-device ${res.status}: ${await res.text()}`);
    }
    const { deletedRows } = (await res.json()) as { deletedRows: number };
    expect(deletedRows, 'reap must remove exactly the (deviceId, user) row — 0 means the staging never registered the device').toBe(1);
}

/** True when the server has a deviceSyncState row for this page's device — i.e. /sync/bootstrap re-registered it. */
function isDeviceRegisteredOnServer(page: Page): Promise<boolean> {
    return page.evaluate(async (apiUrl) => {
        const harness = (window as unknown as { __gtd: { getDeviceId(): Promise<string> } }).__gtd;
        const deviceId = await harness.getDeviceId();
        const res = await fetch(`${apiUrl}/sync/device-status?deviceId=${encodeURIComponent(deviceId)}`, { credentials: 'include' });
        if (!res.ok) {
            throw new Error(`device-status ${res.status}`);
        }
        return ((await res.json()) as { registered: boolean }).registered;
    }, API_URL);
}

/**
 * Stages the Case-2 state: a reaped device with exactly one queued offline op.
 *
 * Offline-ness is simulated with request interception, NOT context.setOffline(true→false):
 * AppDataProvider runs an unconditional flushSyncQueue on the window 'online' event, so flipping
 * setOffline back would fire 'online' and auto-push the queue before the probe ever runs,
 * collapsing the setup into Case 1. Aborting **\/sync\/** instead keeps navigator.onLine true
 * (no 'online' event exists to fire), and a reload while online goes straight into the mount
 * orchestrator's probe-before-flush with the op still queued.
 */
async function stageReapedDeviceWithQueuedOp(page: Page, email: string, title: string): Promise<void> {
    // Block the sync API so the fire-and-forget flush kicked off by queueSyncOp cannot reach the
    // server — the create op must stay queued in IDB.
    await page.route(SYNC_GLOB, (route) => route.abort());
    await gtd.collect(page, title);
    await expect
        .poll(async () => {
            const ops = await gtd.queuedOps(page);
            return ops.some((op) => op.snapshot !== null && 'title' in op.snapshot && op.snapshot.title === title);
        }, 'the queued create op must exist in IDB syncOperations before the reload')
        .toBe(true);
    // Reap while /sync/** is still blocked so no stray flush can slip through before the reload.
    await reapDevice(page, email);
    await page.unroute(SYNC_GLOB);
    await page.reload();
}

/** Waits for the Case-2 choice dialog and asserts its content: unsynced-change count + the three buttons. */
async function expectCase2ChoiceDialog(page: Page, queuedOpCount: number) {
    const dialog = page.getByTestId('syncRecoveryDialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText(`${queuedOpCount} unsynced local change`);
    await expect(page.getByTestId('syncRecoveryPush')).toBeVisible();
    await expect(page.getByTestId('syncRecoveryDiscard')).toBeVisible();
    await expect(page.getByTestId('syncRecoveryExport')).toBeVisible();
    return dialog;
}

async function readDownloadedText(download: Download): Promise<string> {
    return fs.readFile(await download.path(), 'utf8');
}

/** Splits an export file on the RAW JSON separator and parses the tail — the export contract is "summary, separator, parseable JSON". */
function parseRawJsonTail(content: string): unknown {
    const [, tail] = content.split(RAW_JSON_SEPARATOR);
    if (!tail) {
        throw new Error(`export file is missing the "${RAW_JSON_SEPARATOR}" separator`);
    }
    return JSON.parse(tail);
}

test.describe('sync recovery for a reaped device', () => {
    test('case 1: clean device auto-recovers with a full bootstrap', async ({ browser }) => {
        const email = `reap-case1-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await gtd.collect(page, 'Pre-reap item');
            await gtd.flush(page);
            const serverBefore = await gtd.fetchBootstrap(page);
            expect(serverBefore.items.some((i) => i.title === 'Pre-reap item')).toBe(true);

            await reapDevice(page, email);
            await page.reload();

            // Recovery ends with /sync/bootstrap re-registering the device row — poll that as the
            // completion signal instead of trying to catch the (possibly instant) spinner dialog.
            await expect.poll(() => isDeviceRegisteredOnServer(page), { timeout: 20_000 }).toBe(true);
            await expect(page.getByTestId('syncRecoveryDialog')).toBeHidden({ timeout: 10_000 });

            // Bootstrap restored the data — the app works with the item still visible.
            const items = await gtd.listItems(page);
            expect(items.some((i) => i.title === 'Pre-reap item')).toBe(true);

            // A subsequent edit syncs normally: flush lands on the server and pull succeeds
            // (pull would throw bootstrapRequired again if the device were still unregistered).
            await gtd.collect(page, 'Post-recovery item');
            await gtd.flush(page);
            await gtd.pull(page);
            const serverAfter = await gtd.fetchBootstrap(page);
            expect(serverAfter.items.some((i) => i.title === 'Post-recovery item')).toBe(true);
        });
    });

    test('case 2 push path: queued offline changes reach the server, then full sync', async ({ browser }) => {
        const email = `reap-case2-push-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await stageReapedDeviceWithQueuedOp(page, email, 'Offline push item');
            const dialog = await expectCase2ChoiceDialog(page, 1);

            await page.getByTestId('syncRecoveryPush').click();
            await expect(dialog).toBeHidden({ timeout: 15_000 });

            // The offline-created item survived: queue drained, visible in the app, and on the server.
            expect(await gtd.queuedOps(page)).toHaveLength(0);
            await expect.poll(async () => (await gtd.listItems(page)).some((i) => i.title === 'Offline push item'), { timeout: 10_000 }).toBe(true);
            const server = await gtd.fetchBootstrap(page);
            expect(server.items.some((i) => i.title === 'Offline push item')).toBe(true);
            expect(await isDeviceRegisteredOnServer(page)).toBe(true);
        });
    });

    test('case 2 discard path: queued changes are dropped, pre-offline data is intact', async ({ browser }) => {
        const email = `reap-case2-discard-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await gtd.collect(page, 'Pre-offline keeper');
            await gtd.flush(page);
            await stageReapedDeviceWithQueuedOp(page, email, 'Discarded offline item');
            const dialog = await expectCase2ChoiceDialog(page, 1);

            await page.getByTestId('syncRecoveryDiscard').click();
            await expect(dialog).toBeHidden({ timeout: 15_000 });

            // The discarded change never reached the server and its queue entry is gone.
            expect(await gtd.queuedOps(page)).toHaveLength(0);
            const server = await gtd.fetchBootstrap(page);
            expect(server.items.some((i) => i.title === 'Discarded offline item')).toBe(false);
            expect(server.items.some((i) => i.title === 'Pre-offline keeper')).toBe(true);

            // App state after the bootstrap: pre-offline data intact, discarded item gone.
            const items = await gtd.listItems(page);
            expect(items.some((i) => i.title === 'Pre-offline keeper')).toBe(true);
            expect(items.some((i) => i.title === 'Discarded offline item')).toBe(false);
        });
    });

    test('case 2 export: downloads both files and keeps the dialog open', async ({ browser }) => {
        const email = `reap-case2-export-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await stageReapedDeviceWithQueuedOp(page, email, 'Exported offline item');
            const dialog = await expectCase2ChoiceDialog(page, 1);
            const userId = await gtd.getActiveAccountId(page);

            const downloads: Download[] = [];
            page.on('download', (download) => downloads.push(download));
            await page.getByTestId('syncRecoveryExport').click();
            await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(2);

            const filesByName = new Map<string, string>();
            for (const download of downloads) {
                filesByName.set(download.suggestedFilename(), await readDownloadedText(download));
            }
            const date = dayjs().format('YYYY-MM-DD');
            const pendingContent = filesByName.get(`gtd-pending-changes-${userId}-${date}.txt`);
            const snapshotContent = filesByName.get(`gtd-local-snapshot-${userId}-${date}.txt`);
            expect(pendingContent, `pending-changes file missing — got ${[...filesByName.keys()].join(', ')}`).toBeTruthy();
            expect(snapshotContent, `local-snapshot file missing — got ${[...filesByName.keys()].join(', ')}`).toBeTruthy();
            if (!pendingContent || !snapshotContent) {
                throw new Error('expected both export files');
            }

            // Each file: human summary, separator, then a cleanly-parseable pretty-printed JSON tail.
            expect(pendingContent).toContain(RAW_JSON_SEPARATOR);
            expect(snapshotContent).toContain(RAW_JSON_SEPARATOR);
            expect(pendingContent).toContain('Exported offline item');
            const pendingJson = parseRawJsonTail(pendingContent);
            expect(Array.isArray(pendingJson)).toBe(true);
            parseRawJsonTail(snapshotContent);

            // Export is a side action, not a choice — the dialog must still be open.
            await expect(dialog).toBeVisible();

            // Finish via the push path so the test ends in a clean, synced state.
            await page.getByTestId('syncRecoveryPush').click();
            await expect(dialog).toBeHidden({ timeout: 15_000 });
            expect(await gtd.queuedOps(page)).toHaveLength(0);
        });
    });
});
