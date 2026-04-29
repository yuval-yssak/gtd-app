import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import type { AuthVariables } from '../types/authTypes.js';

const DEVICE_ID_HEADER = 'X-Device-Id';

export const pushRoutes = new Hono<{ Variables: AuthVariables }>()
    // Store or refresh the push subscription for this device
    .post('/subscribe', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId, endpoint, keys } = await c.req.json<{
            deviceId: string;
            endpoint: string;
            keys: { p256dh: string; auth: string };
        }>();

        await pushSubscriptionsDAO.upsert({
            _id: deviceId,
            user: user.id,
            endpoint,
            keys,
            updatedTs: dayjs().toISOString(),
        });

        // Mirror the (device, user) pair so push fan-out can find this device for any of its
        // logged-in accounts even though the subscription row itself stores only the registering user.
        await deviceUsersDAO.upsert(deviceId, user.id);

        return c.json({ ok: true }, 200);
    })
    // Remove the subscription when the user unsubscribes or signs out on a device
    .delete('/subscribe', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId } = await c.req.json<{ deviceId: string }>();

        await pushSubscriptionsDAO.deleteByDevice(deviceId, user.id);
        return c.json({ ok: true }, 200);
    })
    // GET /push/status — used by Settings to detect a server-side subscription loss
    // (e.g. SW unregistered, row purged after a 410). Header-keyed by deviceId so the
    // status is per-device regardless of which account is currently active.
    .get('/status', authenticateRequest, async (c) => {
        const deviceId = c.req.header(DEVICE_ID_HEADER);
        if (!deviceId) {
            return c.json({ error: 'X-Device-Id header required' }, 400);
        }

        const existing = await pushSubscriptionsDAO.findOne({ _id: deviceId });
        return c.json({ registered: existing !== null });
    });
