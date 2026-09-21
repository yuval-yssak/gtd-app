/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { google } from 'googleapis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyEntityOp } from '../lib/applyEntityOp.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';
import {
    app,
    getUserId,
    insertIntegrationWithConfig,
    loginAsAlice,
    makeIntegration,
    makeItem,
    makeOp,
    makeRoutine,
    makeSyncConfig,
    mockBuildProvider,
    mockUserInfoEmail,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest, SESSION_COOKIE } from './helpers.js';

useCalendarTestLifecycle();

// ─── lastKnown* rename + strong-key restore on reconnect ───────────────────

describe('disconnect/reconnect — lastKnownCalendar* rename and strong-key restore', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('unlinkItems renames calendar* fields to lastKnown* instead of unsetting them', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-rename-keep',
            user: userId,
            status: 'calendar',
            title: 'Strong-key relink target',
            calendarEventId: 'gcal-keep-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-rename-keep' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarEventId).toBeUndefined();
        expect(item?.calendarIntegrationId).toBeUndefined();
        expect(item?.calendarSyncConfigId).toBeUndefined();
        expect(item?.lastKnownCalendarEventId).toBe('gcal-keep-1');
        expect(item?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(item?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
    });

    it('unlinkRoutines renames calendar* fields to lastKnown*', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-master-keep', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-1' });
        expect(routine?.calendarEventId).toBeUndefined();
        expect(routine?.calendarIntegrationId).toBeUndefined();
        expect(routine?.calendarSyncConfigId).toBeUndefined();
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-master-keep');
        expect(routine?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(routine?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
    });

    it('trashItemsForIntegration renames calendar* fields to lastKnown* on done items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-done-rename',
            user: userId,
            status: 'done',
            title: 'Already done',
            calendarEventId: 'gcal-done-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=removeLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const done = await itemsDAO.findOne({ _id: 'item-done-rename' });
        expect(done?.status).toBe('done');
        expect(done?.calendarEventId).toBeUndefined();
        expect(done?.lastKnownCalendarEventId).toBe('gcal-done-1');
        expect(done?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(done?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
    });

    it('upsertCalendarItem restores an item by lastKnownCalendarEventId on inbound match (single op, fields swap)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureStart = dayjs().add(1, 'day').startOf('hour').toISOString();
        const futureEnd = dayjs(futureStart).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Item carries lastKnown* but no live calendar* — the rename-on-disconnect state.
        await itemsDAO.insertOne({
            _id: 'item-restore-1',
            user: userId,
            status: 'calendar',
            title: 'Restore me',
            timeStart: futureStart,
            timeEnd: futureEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-restore-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-restore-1',
                    title: 'Restore me',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await itemsDAO.findArray({ user: userId, title: 'Restore me' });
        expect(all).toHaveLength(1);
        const [restored] = all;
        if (!restored) throw new Error('expected one restored item');
        expect(restored._id).toBe('item-restore-1');
        expect(restored.calendarEventId).toBe('gcal-restore-1');
        expect(restored.calendarIntegrationId).toBe('int-1');
        expect(restored.calendarSyncConfigId).toBe('sync-config-1');
        expect(restored.lastKnownCalendarEventId).toBeUndefined();
        expect(restored.lastKnownCalendarIntegrationId).toBeUndefined();
        expect(restored.lastKnownCalendarSyncConfigId).toBeUndefined();
    });

    it('tryRestoreFromLastKnownEventId is TOCTOU-safe: a race interleaved between findArray and updateOne lets one writer win and the other fall through', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureStart = dayjs().add(1, 'day').startOf('hour').toISOString();
        const futureEnd = dayjs(futureStart).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-toctou',
            user: userId,
            status: 'calendar',
            title: 'TOCTOU me',
            timeStart: futureStart,
            timeEnd: futureEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-toctou-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        // Interleave a competing mutation between findArray (which already located the candidate)
        // and the conditional updateOne (which checks the `lastKnownCalendarEventId` guard).
        // Spy on itemsDAO.updateOne: when the restore's conditional update fires, apply the rival
        // claim first — that flips the candidate's markers, so the real updateOne matches 0 docs
        // and the restore returns undefined. The caller then falls through to the naked/create path.
        const realUpdateOne = itemsDAO.updateOne.bind(itemsDAO);
        vi.spyOn(itemsDAO, 'updateOne').mockImplementation(async (filter, update, options) => {
            type FilterShape = { lastKnownCalendarEventId?: string };
            const matchesRestoreGuard = (filter as FilterShape).lastKnownCalendarEventId === 'gcal-toctou-1';
            if (matchesRestoreGuard) {
                // Rival webhook restored the item first — clears the markers and binds the calendar* fields.
                await realUpdateOne(
                    { _id: 'item-toctou', user: userId },
                    {
                        $set: { calendarEventId: 'gcal-toctou-1', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' },
                        $unset: { lastKnownCalendarEventId: '', lastKnownCalendarIntegrationId: '', lastKnownCalendarSyncConfigId: '' },
                    },
                );
            }
            return await realUpdateOne(filter, update, options);
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-toctou-1',
                    title: 'TOCTOU me',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-toctou',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The rival's restore wins → the loser's `tryRestoreFromLastKnownEventId` returns undefined and
        // falls through to the create path. That insert now collides on the unique
        // `(user, calendarEventId)` index (rival already bound the live row) → the E11000 catch in
        // `createNewCalendarItem` re-resolves to the rival's row and merges into it instead of producing
        // a duplicate. Net: exactly ONE live item carries the event — strictly better than the old
        // "better duplicate than silent overwrite" fallback this test previously documented.
        const all = await itemsDAO.findArray({ user: userId, title: 'TOCTOU me', status: 'calendar' });
        expect(all).toHaveLength(1);
        const [restored] = all;
        if (!restored) throw new Error('expected the rival-bound item to survive');
        expect(restored._id).toBe('item-toctou');
        expect(restored.calendarEventId).toBe('gcal-toctou-1');
        expect(restored.lastKnownCalendarEventId).toBeUndefined();
    });

    it('cancelled inbound event matching lastKnown* emits no restore op and no status flap', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Item carries lastKnown* markers but no live calendar* — the disconnect-with-keep state.
        await itemsDAO.insertOne({
            _id: 'item-cancel-marker',
            user: userId,
            status: 'calendar',
            title: 'Marker-only — cancelled inbound',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-cancel-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-cancel-1',
                    title: 'Marker-only — cancelled inbound',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                },
            ],
            nextSyncToken: 'tok-cancel',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The item is untouched: cancelled short-circuits BEFORE the restore. No restore op, no
        // trash op, no live calendar* binding. The markers also stay put — the disconnect-with-keep
        // contract is preserved across cancelled inbound events.
        const item = await itemsDAO.findOne({ _id: 'item-cancel-marker' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarEventId).toBeUndefined();
        expect(item?.lastKnownCalendarEventId).toBe('gcal-cancel-1');
    });

    it('past inbound event matching lastKnown* emits no restore op and no status flap', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(2, 'day').toISOString();
        // Past event window — anchor in the previous day so cutoffIso is strictly after timeEnd.
        const pastStart = dayjs().subtract(2, 'day').startOf('hour').toISOString();
        const pastEnd = dayjs(pastStart).add(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-past-marker',
            user: userId,
            status: 'calendar',
            title: 'Marker-only — past inbound',
            timeStart: pastStart,
            timeEnd: pastEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-past-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-past-1',
                    title: 'Marker-only — past inbound',
                    timeStart: pastStart,
                    timeEnd: pastEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-past',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Past-event branch short-circuits before the restore: no live calendar* binding, markers preserved.
        const item = await itemsDAO.findOne({ _id: 'item-past-marker' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarEventId).toBeUndefined();
        expect(item?.lastKnownCalendarEventId).toBe('gcal-past-1');
    });

    it('routine cancelled master matching lastKnown* skips restore and goes straight to deactivate', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Active routine carrying lastKnown* markers — the disconnect-with-keep state.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-cancel-marker',
                active: true,
                lastKnownCalendarEventId: 'gcal-master-cancel',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-1',
            }),
        );

        // Inbound recurring master event for the SAME id with status:'cancelled'.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-cancel',
                    title: makeRoutine(userId).title,
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                    recurrence: [`RRULE:${makeRoutine(userId).rrule}`],
                },
            ],
            nextSyncToken: 'tok-routine-cancel',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Restore was skipped (no calendar* fields bound) — and since the routine was never restored,
        // the deactivate branch fell through with nothing to deactivate. Markers remain intact.
        const routine = await routinesDAO.findOne({ _id: 'routine-cancel-marker' });
        expect(routine?.calendarEventId).toBeUndefined();
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-master-cancel');
        expect(routine?.active).toBe(true);
    });

    it('reconnect: legacy (unstamped) lastKnown* markers with a dead integration id are left intact', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // Seed the prior disconnect state: an item AND a routine both carry markers pointing at the
        // OLD integration id (which the user has since disconnected). No live integration row exists.
        // Neither marker carries lastKnownCalendarAccountEmail (legacy, pre-stamping rows) — the
        // reconcile pass can't prove same-account, so under leave-unlinked it must NOT touch them.
        // They heal later via the relink paths, which accept email-less markers best-effort when the
        // event actually resolves (inbound strong-key restore, or the active sweep's found-event branch).
        const oldTs = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-orphan',
            user: userId,
            status: 'calendar',
            title: 'Orphaned marker',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-orphan-1',
            lastKnownCalendarIntegrationId: 'int-OLD-account',
            lastKnownCalendarSyncConfigId: 'sync-config-OLD',
        });
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-orphan',
                lastKnownCalendarEventId: 'gcal-orphan-master',
                lastKnownCalendarIntegrationId: 'int-OLD-account',
                lastKnownCalendarSyncConfigId: 'sync-config-OLD',
            }),
        );

        // Drive the OAuth callback for a NEW integration (different account, different integration id).
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'new-at', refresh_token: 'new-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);

        // Reconnect produced exactly one integration row, with a fresh id distinct from 'int-OLD-account'.
        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        const liveIntegration = integrations[0];
        if (!liveIntegration) throw new Error('expected one live integration');
        expect(liveIntegration._id).not.toBe('int-OLD-account');
        // Redirect carries the live integration id so the client picker targets the real row.
        expect(res.headers.get('location')).toContain(`calendarConnected=${liveIntegration._id}`);

        // Leave-unlinked: the markers persist verbatim. Wiping them would irreversibly sever the
        // original events (an A→B→A round-trip could no longer relink) and re-arm the outbound
        // backfill into minting clone events on the new account's calendar.
        const orphanItem = await itemsDAO.findOne({ _id: 'item-orphan' });
        expect(orphanItem?.lastKnownCalendarEventId).toBe('gcal-orphan-1');
        expect(orphanItem?.lastKnownCalendarIntegrationId).toBe('int-OLD-account');
        expect(orphanItem?.lastKnownCalendarSyncConfigId).toBe('sync-config-OLD');
        const orphanRoutine = await routinesDAO.findOne({ _id: 'routine-orphan' });
        expect(orphanRoutine?.lastKnownCalendarEventId).toBe('gcal-orphan-master');
        expect(orphanRoutine?.lastKnownCalendarIntegrationId).toBe('int-OLD-account');
        expect(orphanRoutine?.lastKnownCalendarSyncConfigId).toBe('sync-config-OLD');

        // No repair ops either — nothing changed, so peers must not be told anything.
        const itemOps = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-orphan' });
        expect(itemOps).toHaveLength(0);
        const routineOps = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-orphan' });
        expect(routineOps).toHaveLength(0);
    });

    it('double disconnect without reconnect preserves the originally-stored lastKnownCalendarEventId on routines', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        // Pre-existing routine state: a prior disconnect already renamed `calendarEventId` →
        // `lastKnownCalendarEventId`. The routine row keeps a `calendarIntegrationId` (stale; the
        // integration was reconnected without the repair pass clearing it) so it's still discoverable
        // by the integration-scoped lookup in the next DELETE — but its `calendarEventId` is gone.
        // The defensive `calendarEventId: { $exists: true }` filter ensures the second rename does
        // NOT clobber the previously-stored lastKnownCalendarEventId.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-double-disconnect',
                calendarIntegrationId: 'int-1', // still linked at the integration level
                lastKnownCalendarEventId: 'gcal-first-link-PRESERVE',
                lastKnownCalendarIntegrationId: 'int-PRIOR',
                lastKnownCalendarSyncConfigId: 'sync-config-PRIOR',
                // calendarEventId intentionally undefined — already renamed by an earlier disconnect.
            }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-double-disconnect' });
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-first-link-PRESERVE');
        expect(routine?.calendarEventId).toBeUndefined();
    });

    it('removeLinkedEntities renames routine calendar* fields to lastKnown* and deactivates, recording the renamed snapshot', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId, { accountEmail: 'Alice@Example.com' }));
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-master-remove', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=removeLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-1' });
        expect(routine?.active).toBe(false);
        expect(routine?.calendarEventId).toBeUndefined();
        expect(routine?.calendarIntegrationId).toBeUndefined();
        expect(routine?.calendarSyncConfigId).toBeUndefined();
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-master-remove');
        expect(routine?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(routine?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
        // Lowercased origin-account stamp — lets a later reconnect distinguish same-account (restore)
        // from cross-account (wipe).
        expect(routine?.lastKnownCalendarAccountEmail).toBe('alice@example.com');

        // The recorded op must advertise the RENAMED + deactivated state — recording the pre-rename
        // snapshot would propagate the stale still-linked state to other devices.
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-1' });
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one routine op');
        expect(op.opType).toBe('update');
        const snapshot = op.snapshot as RoutineInterface | null;
        expect(snapshot?.active).toBe(false);
        expect(snapshot?.calendarEventId).toBeUndefined();
        expect(snapshot?.lastKnownCalendarEventId).toBe('gcal-master-remove');
    });

    it('same-account reconnect after removeLinkedEntities restores the deactivated routine (no twin) and regenerates items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Post-remove-disconnect state: deactivated routine whose markers point at the DELETED
        // integration id. The reconnect minted a brand-new integration id (int-1 below).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-restore-remove',
                active: false,
                lastKnownCalendarEventId: 'gcal-master-restore',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
            }),
        );
        await insertIntegrationWithConfig(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-restore',
                    title: 'Standup',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The SAME routine doc is restored — reactivated and relinked to the new integration ids.
        const routines = await routinesDAO.findArray({ user: userId });
        expect(routines).toHaveLength(1);
        const [restored] = routines;
        if (!restored) throw new Error('expected the restored routine');
        expect(restored._id).toBe('routine-restore-remove');
        expect(restored.active).toBe(true);
        expect(restored.calendarEventId).toBe('gcal-master-restore');
        expect(restored.calendarIntegrationId).toBe('int-1');
        expect(restored.calendarSyncConfigId).toBe('sync-config-1');
        expect(restored.lastKnownCalendarEventId).toBeUndefined();
        expect(restored.lastKnownCalendarIntegrationId).toBeUndefined();
        expect(restored.lastKnownCalendarSyncConfigId).toBeUndefined();
        expect(restored.lastKnownCalendarAccountEmail).toBeUndefined();

        // The disconnect cascade trashed all generated items — reactivation must rebuild them.
        const regenerated = await itemsDAO.findArray({ user: userId, routineId: 'routine-restore-remove', status: 'calendar' });
        expect(regenerated.length).toBeGreaterThan(0);
    });

    it('cross-account reconnect leaves remove-mode markers intact and imports a fresh routine instead of hijacking', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // Remove-mode disconnect state left by the WORK account.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-work-orphan',
                active: false,
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-work-master',
                lastKnownCalendarIntegrationId: 'int-WORK',
                lastKnownCalendarSyncConfigId: 'sync-config-WORK',
                lastKnownCalendarAccountEmail: 'work@example.com',
            }),
        );
        // A leftover generated item still carrying an instance id derived from the WORK master —
        // under leave-unlinked it persists too: its routine stays unlinked, so it never participates
        // in the new account's exception sync and the stale id is inert.
        const oldTs = dayjs().subtract(3, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-work-orphan-instance',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-work-orphan',
            calendarInstanceEventId: 'gcal-work-master_20260701T060000Z',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // Reconnect with a DIFFERENT Google account (alice's, not work's) → the markers' origin email
        // no longer matches the live integration, so reconcileLastKnownMarkers leaves them untouched.
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'new-at', refresh_token: 'new-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');
        const cbRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(cbRes.status).toBe(302);

        const [liveIntegration] = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        if (!liveIntegration) throw new Error('expected a live integration');
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, liveIntegration._id, { _id: 'sync-config-live' }));

        // The shared-calendar case: the new account sees the SAME event id. The work marker still
        // exists, but the restore is account-scoped (markerOriginAccountScope) — it must NOT match
        // the other-account marker, so the import creates a fresh routine instead of hijacking it.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-work-master',
                    title: 'Standup',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-cross',
        });
        const syncRes = await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${liveIntegration._id}/sync`, sessionCookie });
        expect(syncRes.status).toBe(200);

        // Original routine untouched: still inactive, unlinked, markers PRESERVED — reconnecting the
        // work account later can still relink it to its original series.
        const orphan = await routinesDAO.findOne({ _id: 'routine-work-orphan' });
        expect(orphan?.active).toBe(false);
        expect(orphan?.calendarEventId).toBeUndefined();
        expect(orphan?.lastKnownCalendarEventId).toBe('gcal-work-master');
        expect(orphan?.lastKnownCalendarAccountEmail).toBe('work@example.com');
        // The orphaned routine's leftover item keeps its (inert) instance id for the same reason.
        const orphanItem = await itemsDAO.findOne({ _id: 'item-work-orphan-instance' });
        expect(orphanItem?.calendarInstanceEventId).toBe('gcal-work-master_20260701T060000Z');

        // The inbound master created a FRESH routine under the new account's integration.
        const fresh = await routinesDAO.findOne({ calendarEventId: 'gcal-work-master' });
        expect(fresh).not.toBeNull();
        expect(fresh!._id).not.toBe('routine-work-orphan');
        expect(fresh!.active).toBe(true);
        expect(fresh!.calendarIntegrationId).toBe(liveIntegration._id);
    });

    it('split base + successor pair both restore after a remove-mode disconnect + reconnect (no twins)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const cappedRrule = `FREQ=WEEKLY;BYDAY=MO;UNTIL=${dayjs().subtract(2, 'week').format('YYYYMMDD[T]HHmmss[Z]')}`;

        // Post-remove-disconnect state of a "this and all following" split: capped base + open
        // successor, both deactivated with markers on the shared bare id.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-split-base',
                active: false,
                rrule: cappedRrule,
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-split-1',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-split-succ',
                title: 'Standup (moved)',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TU',
                calendarRebasedEventId: 'gcal-split-1_R20260620T090000',
                splitFromRoutineId: 'routine-split-base',
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-split-1',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await insertIntegrationWithConfig(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-split-1',
                    title: 'Standup',
                    timeStart: dayjs().subtract(8, 'week').toISOString(),
                    timeEnd: dayjs().subtract(8, 'week').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:${cappedRrule}`],
                },
                {
                    id: 'gcal-split-1_R20260620T090000',
                    title: 'Standup (moved)',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
            ],
            nextSyncToken: 'tok-split-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No new routine docs — the pair was restored in place.
        const routines = await routinesDAO.findArray({ user: userId });
        expect(routines).toHaveLength(2);

        const base = await routinesDAO.findOne({ _id: 'routine-split-base' });
        expect(base?.calendarEventId).toBe('gcal-split-1');
        expect(base?.calendarIntegrationId).toBe('int-1');
        // The capped segment stays paused — GCal truth (rrule with UNTIL) is not a live series.
        expect(base?.active).toBe(false);
        expect(base?.lastKnownCalendarEventId).toBeUndefined();

        const successor = await routinesDAO.findOne({ _id: 'routine-split-succ' });
        expect(successor?.calendarEventId).toBe('gcal-split-1');
        expect(successor?.calendarRebasedEventId).toBe('gcal-split-1_R20260620T090000');
        expect(successor?.calendarIntegrationId).toBe('int-1');
        expect(successor?.active).toBe(true);
        expect(successor?.lastKnownCalendarEventId).toBeUndefined();

        // Only the live successor regenerates items.
        const succItems = await itemsDAO.findArray({ user: userId, routineId: 'routine-split-succ', status: 'calendar' });
        expect(succItems.length).toBeGreaterThan(0);
        const baseItems = await itemsDAO.findArray({ user: userId, routineId: 'routine-split-base', status: 'calendar' });
        expect(baseItems).toHaveLength(0);
    });

    it('restore that races a concurrent active twin catches the E11000 and falls through without a 500', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-race-marker',
                active: false,
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-master-race-restore',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await insertIntegrationWithConfig(userId);

        // Interleave the race: a rival sync activates a routine on the same series AFTER the restore
        // candidate was read but BEFORE its conditional update executes. The reactivating $set then
        // violates uniq_active_routine_per_gcal_series — the catch must treat it as a miss, not 500.
        const realUpdateOne = routinesDAO.updateOne.bind(routinesDAO);
        let rivalInjected = false;
        vi.spyOn(routinesDAO, 'updateOne').mockImplementation(async (filter, update, options) => {
            type FilterShape = { lastKnownCalendarEventId?: string };
            if ((filter as FilterShape).lastKnownCalendarEventId === 'gcal-master-race-restore' && !rivalInjected) {
                rivalInjected = true;
                await routinesDAO.insertOne(
                    makeRoutine(userId, {
                        _id: 'routine-race-rival',
                        active: true,
                        calendarEventId: 'gcal-master-race-restore',
                        calendarIntegrationId: 'int-1',
                        calendarSyncConfigId: 'sync-config-1',
                    }),
                );
            }
            return await realUpdateOne(filter, update, options);
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-race-restore',
                    title: 'Standup',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-race-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(rivalInjected).toBe(true);

        // Race loser: the marker routine is untouched — markers intact, still inactive, not relinked.
        const marker = await routinesDAO.findOne({ _id: 'routine-race-marker' });
        expect(marker?.active).toBe(false);
        expect(marker?.calendarEventId).toBeUndefined();
        expect(marker?.lastKnownCalendarEventId).toBe('gcal-master-race-restore');

        // Exactly one ACTIVE routine holds the series — the rival winner.
        const active = await routinesDAO.findArray({ user: userId, calendarEventId: 'gcal-master-race-restore', active: true });
        expect(active).toHaveLength(1);
        const [winner] = active;
        if (!winner) throw new Error('expected the rival winner');
        expect(winner._id).toBe('routine-race-rival');
    });

    it('pushback skips items carrying lastKnownCalendarEventId (no create, no update)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-pb-skip',
            lastKnownCalendarEventId: 'gcal-was-linked',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'should-not-create' });
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('pushback skips routines carrying lastKnownCalendarEventId (no series create or update)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            lastKnownCalendarEventId: 'gcal-master-was-linked',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const createRecurringSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('should-not-create');
        const updateRecurringSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createRecurringSpy).not.toHaveBeenCalled();
        expect(updateRecurringSpy).not.toHaveBeenCalled();
    });
});

// ─── reconnect — heals stale calendarIntegrationId on items ────────────────

describe('reconnect — inbound sync heals stale calendarIntegrationId', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('rewrites calendarIntegrationId from old to current when GCal sends a newer update', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Current (post-reconnect) integration — id `int-1`, default config `sync-config-1`.
        await insertIntegrationWithConfig(userId);

        // Item points at a DELETED prior integration (`int-old`) — the disconnect+reconnect dance
        // never rewrote it because no inbound update touched the item between reconnects.
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-stale',
            user: userId,
            status: 'calendar',
            title: 'Old title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-stale',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-stale', title: 'New title', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-stale', userId);
        expect(updated).toBeTruthy();
        expect(updated!.title).toBe('New title');
        // Both link fields must be refreshed — if calendarIntegrationId stayed `int-old`, the next
        // local push would silently no-op in resolvePushContext.
        expect(updated!.calendarIntegrationId).toBe('int-1');
        expect(updated!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('notes-only inbound update still refreshes both link ids', async () => {
        // Regression guard for the structurallyNewer gate: a notes-only inbound payload (no
        // title/time change) must still bring `calendarIntegrationId` + `calendarSyncConfigId`
        // forward — otherwise an item whose only post-reconnect inbound is a notes edit stays
        // pinned to the dead integration.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const t1 = dayjs().subtract(2, 'hour').toISOString();
        const t2 = dayjs().subtract(30, 'minute').toISOString();
        const t3 = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-stale-notesonly',
            user: userId,
            status: 'calendar',
            title: 'Title at T3',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-stale-notesonly',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            lastSyncedNotes: '<p>old desc</p>',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t3,
        });

        // event.updated = T2 sits between local updatedTs (T1) and anchor (T3) → notes apply,
        // structural fields don't (`structurallyNewer = false`).
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-stale-notesonly',
                    title: 'Title at T3',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: t2,
                    status: 'confirmed',
                    description: '<p>new desc</p>',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-stale-notesonly', userId);
        expect(item!.notes).toBe('new desc');
        // Link must be healed even though no structural change occurred.
        expect(item!.calendarIntegrationId).toBe('int-1');
        expect(item!.calendarSyncConfigId).toBe('sync-config-1');
        // Anchor stays at T3 — same guard as the existing notes-only-no-regress test.
        expect(item!.lastSyncedFromGCalTs).toBe(t3);
    });

    it('reviveTrashedCalendarItem also brings calendarIntegrationId forward', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Item is trashed (e.g. by disconnect-with-remove cascade) and references the gone integration.
        const oldTs = dayjs().subtract(2, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-revive',
            user: userId,
            status: 'trash',
            title: 'Will revive',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-revive',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-revive', title: 'Will revive', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-revive', userId);
        expect(updated).toBeTruthy();
        expect(updated!.status).toBe('calendar');
        expect(updated!.calendarIntegrationId).toBe('int-1');
        expect(updated!.calendarSyncConfigId).toBe('sync-config-1');
    });
});

// ─── pushback — self-heals stale calendarIntegrationId ────────────────────

describe('pushback self-heal — stale calendarIntegrationId falls back to user default', () => {
    it('trash push deletes the GCal event via the active integration when stored integrationId is gone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // User has exactly one active integration (`int-1`) — the prior `int-old` row is gone.
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-stale-trash',
            calendarEventId: 'gcal-stale-trash',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).toHaveBeenCalledOnce();
        expect(deleteSpy).toHaveBeenCalledWith('primary', 'gcal-stale-trash');

        // Row was healed in place — the next pushback won't re-pay the fallback lookup.
        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');

        // An op was recorded for cross-device convergence (separate from the lastPushedToGCalTs stamp).
        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const healOp = ops.find((o) => {
            const snap = o.snapshot as ItemInterface | null;
            return o.opType === 'update' && snap?.calendarIntegrationId === 'int-1' && snap?.calendarSyncConfigId === 'sync-config-1';
        });
        expect(healOp).toBeTruthy();
    });

    it('done push marks the GCal event via the active integration when stored integrationId is gone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-stale-done',
            calendarEventId: 'gcal-stale-done',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'done',
            title: 'Visit the doctor',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId, updates] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-stale-done');
        expect(updates).toMatchObject({ title: '✓ Visit the doctor', colorId: '2' });

        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('reschedule push updates the GCal event via the active integration when stored integrationId is gone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-stale-move',
            calendarEventId: 'gcal-stale-move',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'calendar',
            title: 'Field trip',
            timeStart: dayjs().add(7, 'day').toISOString(),
            timeEnd: dayjs().add(7, 'day').add(1, 'hour').toISOString(),
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-stale-move');

        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('no-ops when there is no active integration to fall back to', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // User has NO active integration — the prior one was disconnected and no reconnect happened.

        const item = makeItem(userId, {
            _id: 'item-stale-nofb',
            calendarEventId: 'gcal-stale-nofb',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // No fallback → no GCal call, no heal, no op pollution.
        expect(deleteSpy).not.toHaveBeenCalled();
        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-old');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-old');
    });

    it('heal write does not clobber a concurrent client edit with older updatedTs', async () => {
        // Regression for the LWW trap: the heal write is plumbing-only (calendarIntegrationId +
        // calendarSyncConfigId rewrite) and must NOT bump the entity's updatedTs anchor. If it did,
        // a concurrent offline client edit with updatedTs T2 (T1 < T2 < T_heal) would be silently
        // rejected on replay by `existing.updatedTs <= snapshot.updatedTs` — the heal would have
        // artificially advanced the anchor past the legitimate user edit.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const t1 = dayjs().subtract(1, 'hour').toISOString();
        const t2 = dayjs().subtract(10, 'second').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-heal-vs-lww',
            user: userId,
            status: 'calendar',
            title: 'Original title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'gcal-heal-vs-lww',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: t1,
            updatedTs: t1,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        // Step 1: pushback fires for a (notional) client op against the stale-linked item — heal runs.
        const triggerSnapshot: ItemInterface = {
            _id: 'item-heal-vs-lww',
            user: userId,
            status: 'calendar',
            title: 'Original title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'gcal-heal-vs-lww',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: t1,
            updatedTs: t1,
        };
        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: 'item-heal-vs-lww', snapshot: triggerSnapshot, ts: t1 }), mockBuildProvider());

        // After heal: row carries new link ids but the LWW anchor is still T1.
        const postHeal = await itemsDAO.findByOwnerAndId('item-heal-vs-lww', userId);
        expect(postHeal!.calendarIntegrationId).toBe('int-1');
        expect(postHeal!.calendarSyncConfigId).toBe('sync-config-1');
        expect(postHeal!.updatedTs).toBe(t1);

        // Step 2: a real client edit with updatedTs T2 (newer than T1) replays via applyEntityOp.
        const clientEdit: ItemInterface = {
            ...postHeal!,
            title: 'User edited title',
            updatedTs: t2,
        };
        await applyEntityOp(userId, {
            _id: 'op-client-edit',
            user: userId,
            deviceId: 'device-client',
            ts: t2,
            entityType: 'item',
            entityId: 'item-heal-vs-lww',
            opType: 'update',
            snapshot: clientEdit,
        });

        // The user's edit must win — the heal must not have locked it out by bumping the anchor.
        const final = await itemsDAO.findByOwnerAndId('item-heal-vs-lww', userId);
        expect(final!.title).toBe('User edited title');
        expect(final!.updatedTs).toBe(t2);
        // Healed link ids carry through into the client snapshot (the client already saw the healed
        // values via the recorded heal op before staging its own edit).
        expect(final!.calendarIntegrationId).toBe('int-1');
        expect(final!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('happy path: item already references the active integration → no heal op written', async () => {
        // Guards against accidental over-eager heals — when the link is valid, resolvePushContext
        // must succeed on its first DAO lookup, tryHealStaleLink never runs, and the op log gets
        // no server-origin heal op for this item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-no-drift',
            calendarEventId: 'gcal-no-drift',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const serverHealOps = ops.filter((o) => {
            if (o.deviceId !== 'server' || o.opType !== 'update') {
                return false;
            }
            const snap = o.snapshot as ItemInterface | null;
            return snap?.calendarIntegrationId === 'int-1';
        });
        expect(serverHealOps).toHaveLength(0);
    });

    it('heals when snapshot.calendarIntegrationId is entirely absent (client wiped the link)', async () => {
        // Production symptom: a client mutation can stage a snapshot with no calendarIntegrationId
        // at all (not stale, absent). Pre-fix the "no integrationId — skipping" early-return bailed
        // before the heal could attempt fallback. Now the absent-integration path also reroutes
        // through tryHealStaleLink, picks the user's default active integration, and proceeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-absent-int',
            calendarEventId: 'gcal-absent-int',
            status: 'done',
            title: 'Push me anyway',
        });
        // Intentionally omit calendarIntegrationId/calendarSyncConfigId — this is the bug shape.
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // GCal call landed via the fallback integration.
        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-absent-int');

        // The row was healed in place — next push won't re-pay the fallback lookup.
        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');

        // Heal op was recorded so other devices learn about the healed link on their next sync pull.
        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const healOp = ops.find((o) => {
            const snap = o.snapshot as ItemInterface | null;
            return o.opType === 'update' && snap?.calendarIntegrationId === 'int-1' && snap?.calendarSyncConfigId === 'sync-config-1';
        });
        expect(healOp).toBeTruthy();
    });

    it('absent-integration heal: still bails when no active integration exists for the user', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // No insertIntegrationWithConfig — user is currently disconnected.

        const item = makeItem(userId, {
            _id: 'item-absent-int-no-fb',
            calendarEventId: 'gcal-absent-int-no-fb',
            status: 'done',
            title: 'No fallback',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // Nothing to fall back to → no GCal call, no row mutation, no spurious heal op.
        expect(updateSpy).not.toHaveBeenCalled();
        const after = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(after!.calendarIntegrationId).toBeUndefined();
        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const serverHealOps = ops.filter((o) => o.deviceId === 'server' && o.opType === 'update');
        expect(serverHealOps).toHaveLength(0);
    });
});

// ─── pushback skips fromGmail items (read-only via Calendar API) ─────────────────

describe('pushback skip — fromGmail events are Calendar-API-read-only', () => {
    it('done transition on a fromGmail item: no provider call, local status stays done', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-fromgmail-done',
            calendarEventId: 'gcal-fromgmail-done',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'done',
            title: 'Visit doctor (Gmail-created)',
            eventType: 'fromGmail',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // Google rejects writes to fromGmail events with 400. We skip the attempt entirely.
        expect(updateSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();

        // Local state unchanged — the GTD-side status flip persists regardless of GCal skip.
        const after = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(after!.status).toBe('done');
    });

    it('trash transition on a fromGmail item: no provider call', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-fromgmail-trash',
            calendarEventId: 'gcal-fromgmail-trash',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
            title: 'Cancel doctor visit',
            eventType: 'fromGmail',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('hard-delete op on a fromGmail item: no provider call', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const snapshot = makeItem(userId, {
            _id: 'item-fromgmail-hard-delete',
            calendarEventId: 'gcal-fromgmail-hard-delete',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
            title: 'Hard delete me',
            eventType: 'fromGmail',
        });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: snapshot._id!, snapshot, opType: 'delete' }), mockBuildProvider());

        // handleItemDelete must skip the delete call for fromGmail (Google would 400/403).
        expect(deleteSpy).not.toHaveBeenCalled();
    });
});
