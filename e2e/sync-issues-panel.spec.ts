import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Sync Issues panel — informative rows. Stages the real entity_missing scenario: an item that a
// second device hard-deleted server-side while this device still holds a local copy. The stale
// update push is rejected (graceful-block) and must surface in the panel with the item's TITLE,
// entity type, and timestamp — not just a generic "Update failed" line.

const API_URL = 'http://localhost:4000';
const CLIENT_URL = 'http://localhost:4173';
const EMAIL = 'sync-issues-panel@test.com';
const ITEM_TITLE = 'Ghost item for sync issues panel';
const SYNC_GLOB = '**/sync/**';

test.beforeEach(async () => {
    await resetServerForEmails([EMAIL]);
});

/**
 * Hard-deletes the item server-side via /sync/push from a fabricated second device. Runs as a
 * test-side fetch (session cookie forwarded manually) so page-level request interception cannot
 * swallow it while `**\/sync\/**` is blocked on the page.
 */
async function pushDeleteFromGhostDevice(cookieHeader: string, itemId: string): Promise<void> {
    const res = await fetch(`${API_URL}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify({
            deviceId: 'e2e-ghost-device',
            ops: [{ entityType: 'item', entityId: itemId, opType: 'delete', snapshot: null, queuedAt: dayjs().toISOString() }],
        }),
    });
    if (!res.ok) {
        throw new Error(`sync/push (ghost delete) ${res.status}: ${await res.text()}`);
    }
}

test('entity_missing update surfaces a titled sync issue row and can be dismissed', async ({ browser }) => {
    await withOneLoggedInDevice(browser, EMAIL, async (page) => {
        const item = await gtd.collect(page, ITEM_TITLE);
        // Wait until the create op has flushed — the delete below must find the item on the server.
        await expect.poll(async () => (await gtd.queuedOps(page)).length, 'create op must flush before the server-side delete').toBe(0);

        // Block the page's sync traffic BEFORE the server-side delete so the delete op cannot be
        // pulled into this device (which would remove the local copy before we edit it).
        await page.route(SYNC_GLOB, (route) => route.abort());
        const cookieHeader = (await page.context().cookies(API_URL)).map((c) => `${c.name}=${c.value}`).join('; ');
        await pushDeleteFromGhostDevice(cookieHeader, item._id);

        // Edit the now-server-deleted item locally — queues a stale update op.
        await gtd.updateItem(page, { ...item, notes: 'edited while deleted elsewhere' });
        await expect.poll(async () => (await gtd.queuedOps(page)).length, 'the stale update op must be queued').toBeGreaterThan(0);

        // Reload with sync unblocked: the mount flush pushes the stale op, the server marks it
        // entity_missing (graceful-block), and the panel's mount fetch surfaces it.
        await page.unroute(SYNC_GLOB);
        await page.goto(CLIENT_URL);

        // AppNav double-mounts the drawer (desktop + mobile), so the badge exists twice — target
        // the visible copy, same convention as the accountSwitcherTrigger specs.
        const badge = page.getByTestId('syncIssuesBadge').locator('visible=true').first();
        await expect(badge).toBeVisible({ timeout: 15_000 });
        await badge.click();

        const entry = page.getByTestId('syncIssueEntry');
        await expect(entry).toHaveCount(1);
        // The row must NAME the affected item (title from the op snapshot)…
        await expect(page.getByTestId('syncIssueTitle')).toContainText(ITEM_TITLE);
        // …say what happened and why…
        await expect(entry).toContainText('Update failed');
        await expect(entry).toContainText('no longer exists');
        // …and carry the entity type + timestamp meta line.
        await expect(page.getByTestId('syncIssueMeta')).toContainText('Item ·');
        // entity_missing is terminal: the raw server detail line (which restates the label) is hidden.
        await expect(page.getByTestId('syncIssueDetail')).toHaveCount(0);

        await page.getByTestId('syncIssueDismiss').click();
        await expect(page.getByTestId('syncIssuesPanel')).toContainText('No sync issues right now.');
    });
});
