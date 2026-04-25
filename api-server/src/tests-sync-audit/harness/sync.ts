import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { SESSION_COOKIE_NAME } from '../../auth/constants.js';
import { auth, db } from '../../loaders/mainLoader.js';
import { calendarRoutes } from '../../routes/calendar.js';
import { syncRoutes } from '../../routes/sync.js';
import type { AuthVariables } from '../../types/authTypes.js';

// Build a test app that mounts the same routes the real server does.
// Kept local so one audit run never interferes with a dev server on :4000.
let app: Hono<{ Variables: AuthVariables }> | null = null;
function getApp() {
    if (app) return app;
    app = new Hono<{ Variables: AuthVariables }>()
        .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
        .route('/calendar', calendarRoutes)
        .route('/sync', syncRoutes);
    return app;
}

/** Mints a signed Better Auth session cookie for an existing user. Mirrors devLogin.ts. */
export async function mintSessionCookie(userId: string): Promise<string> {
    const rawToken = generateId(32);
    const sessionId = generateId(32);
    const now = dayjs();
    const expiresAt = now.add(30, 'day').toDate();
    await db.collection('session').insertOne({
        _id: sessionId,
        userId,
        token: rawToken,
        expiresAt,
        createdAt: now.toDate(),
        updatedAt: now.toDate(),
        ipAddress: '',
        userAgent: 'sync-audit',
    } as never);
    const secret =
        (auth as unknown as { options: { secret?: string } }).options?.secret ??
        process.env.BETTER_AUTH_SECRET ??
        'dev_better_auth_secret_change_in_production';
    const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(rawToken, 'utf8')).digest('base64');
    return encodeURIComponent(`${rawToken}.${sig}`);
}

/** Triggers a pull-sync for a specific integration. Returns the response JSON. */
export async function triggerSync(
    sessionCookie: string,
    integrationId: string,
): Promise<{ ok: boolean; syncedRoutines?: number; syncedCalendars?: number; error?: string }> {
    const res = await getApp().fetch(
        new Request(`http://localhost:4000/calendar/integrations/${integrationId}/sync`, {
            method: 'POST',
            headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
        }),
    );
    const body = (await res.json()) as { ok?: boolean; syncedRoutines?: number; syncedCalendars?: number; error?: string };
    return { ok: res.ok && body.ok === true, ...body };
}

/** Links an existing local routine to a newly created GCal series (pushes create). */
export async function linkRoutine(sessionCookie: string, integrationId: string, routineId: string): Promise<{ calendarEventId?: string; status: number }> {
    const res = await getApp().fetch(
        new Request(`http://localhost:4000/calendar/integrations/${integrationId}/link-routine/${routineId}`, {
            method: 'POST',
            headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
        }),
    );
    const body = (await res.json().catch(() => ({}))) as { calendarEventId?: string };
    return { status: res.status, ...body };
}
