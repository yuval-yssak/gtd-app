/**
 * `focus` was removed from items and routine templates (replaced by the `rank` priority order).
 * Old clients still send it, so the op schemas accept it — but `stampSnapshot` strips it, so
 * neither the collection row nor the op log carries the flag after any write path.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyAndPublishOperation } from '../lib/applyOperation.js';
import { stripDeprecatedFocus } from '../lib/deprecatedFocus.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import { validateOperation } from '../schemas/operations/index.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('account').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('deviceSyncState').deleteMany({}),
    ]);
});

const T0 = '2026-10-20T10:00:00.000Z';

const legacyItem = (user: string): ItemInterface & { focus: boolean } => ({
    _id: 'item-focus-1',
    user,
    status: 'nextAction',
    title: 'legacy focused task',
    focus: true,
    urgent: true,
    createdTs: T0,
    updatedTs: T0,
});

const legacyRoutine = (user: string): RoutineInterface => ({
    _id: 'routine-focus-1',
    user,
    title: 'legacy focused routine',
    routineType: 'nextAction',
    rrule: 'FREQ=DAILY',
    template: { energy: 'low', focus: true } as RoutineInterface['template'],
    active: true,
    createdTs: T0,
    updatedTs: T0,
});

describe('stripDeprecatedFocus (pure)', () => {
    it('drops focus from an item snapshot and keeps every other field', () => {
        const { focus: _f, ...expected } = legacyItem('u');
        expect(stripDeprecatedFocus(legacyItem('u'))).toEqual(expected);
    });

    it('drops template.focus from a routine snapshot and keeps the rest of the template', () => {
        const stripped = stripDeprecatedFocus(legacyRoutine('u')) as RoutineInterface;
        expect(stripped.template).toEqual({ energy: 'low' });
        expect(stripped.title).toBe('legacy focused routine');
    });

    it('is a no-op for snapshots without the flag', () => {
        const { focus: _f, ...clean } = legacyItem('u');
        expect(stripDeprecatedFocus(clean)).toEqual(clean);
    });
});

describe('op schemas still accept focus (old clients must not jam)', () => {
    it('item snapshot with focus validates', () => {
        const result = validateOperation({ entityType: 'item', opType: 'create', entityId: 'item-focus-1', snapshot: legacyItem('u') });
        expect(result.ok).toBe(true);
    });

    it('focus on an inbox item is no longer a status×field violation (deprecated fields are not gated)', () => {
        const result = validateOperation({
            entityType: 'item',
            opType: 'create',
            entityId: 'i',
            snapshot: { ...legacyItem('u'), status: 'inbox', urgent: undefined },
        });
        expect(result.ok).toBe(true);
    });

    it('routine snapshot with template.focus validates', () => {
        const result = validateOperation({ entityType: 'routine', opType: 'create', entityId: 'routine-focus-1', snapshot: legacyRoutine('u') });
        expect(result.ok).toBe(true);
    });
});

describe('the apply pipeline strips focus', () => {
    const userId = 'user-focus-pipeline';

    it('item: neither the row nor the op log carries it', async () => {
        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: 'item-focus-1', snapshot: legacyItem(userId) },
            { deviceId: 'dev' },
        );
        expect(op.snapshot).not.toHaveProperty('focus');
        expect(await itemsDAO.findByOwnerAndId('item-focus-1', userId)).not.toHaveProperty('focus');
        const [logged] = await operationsDAO.findArray({ user: userId });
        expect(logged?.snapshot).not.toHaveProperty('focus');
        expect((logged?.snapshot as ItemInterface | undefined)?.urgent).toBe(true);
    });

    it('routine: template.focus is gone from the row and the op', async () => {
        await applyAndPublishOperation(
            userId,
            { entityType: 'routine', opType: 'create', entityId: 'routine-focus-1', snapshot: legacyRoutine(userId) },
            { deviceId: 'dev' },
        );
        const row = await routinesDAO.findByOwnerAndId('routine-focus-1', userId);
        expect(row?.template).toEqual({ energy: 'low' });
        const [logged] = await operationsDAO.findArray({ user: userId });
        expect((logged?.snapshot as RoutineInterface | undefined)?.template).toEqual({ energy: 'low' });
    });
});

describe('POST /sync/push with a legacy focus snapshot', () => {
    it('is accepted (200) and lands without focus on the row and in the op log', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const sessionRes = await app.fetch(
            new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }),
        );
        const { user } = (await sessionRes.json()) as { user: { id: string } };
        const { user: _u, ...snapshot } = legacyItem(user.id);
        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/sync/push',
            sessionCookie: sessionCookie ?? '',
            body: {
                deviceId: 'legacy-device',
                ops: [{ entityType: 'item', entityId: 'item-focus-1', opType: 'create', queuedAt: T0, snapshot: { ...snapshot, userId: user.id } }],
            },
        });
        expect(res.status).toBe(200);
        expect(await itemsDAO.findByOwnerAndId('item-focus-1', user.id)).not.toHaveProperty('focus');
        const ops = await operationsDAO.findArray({ user: user.id });
        expect(ops).toHaveLength(1);
        expect(ops[0]?.snapshot).not.toHaveProperty('focus');
    });
});
