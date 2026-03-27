import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import type { AuthVariables } from '../types/authTypes.js';

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

        return c.json({ ok: true }, 200);
    })
    // Remove the subscription when the user unsubscribes or signs out on a device
    .delete('/subscribe', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId } = await c.req.json<{ deviceId: string }>();

        await pushSubscriptionsDAO.collection.deleteOne({ _id: deviceId, user: user.id } as never);
        return c.json({ ok: true }, 200);
    });
