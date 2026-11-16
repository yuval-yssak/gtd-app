// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { fetchVapidConfig } from '#api/syncClient';
import { requestAndRegisterPushSubscription } from '../db/pushSubscription';
import { openTestDB } from './openTestDB';

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

/** A browser that supports push and where the user has already granted notifications. */
function stubPushCapableBrowser() {
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    vi.stubGlobal('PushManager', class {});
    Object.defineProperty(navigator, 'serviceWorker', { value: { ready: new Promise(() => undefined) }, configurable: true });
}

beforeEach(() => {
    stubPushCapableBrowser();
});

afterEach(() => {
    if (originalServiceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    } else {
        Reflect.deleteProperty(navigator, 'serviceWorker');
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

// The Settings "Enable" button and the notification nudge call this from a click. Registration now
// throws on a server error answer or a hang (so the connection supervisor retries it); escaping the
// click handler, that replaced the Settings page with the error screen and stranded the nudge.
describe('requestAndRegisterPushSubscription', () => {
    it('reports "not registered" instead of throwing when the server cannot be reached', async () => {
        vi.mocked(fetchVapidConfig).mockRejectedValueOnce(new Error('GET /sync/config 503'));
        const db = await openTestDB();

        await expect(requestAndRegisterPushSubscription(db)).resolves.toBe(false);

        db.close();
    });
});
