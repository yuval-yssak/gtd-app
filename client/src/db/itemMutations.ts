import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { EnergyLevel, MyDB, StoredItem } from '../types/MyDB';
import { deleteItemById, putItem } from './itemHelpers';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

function buildBaseItem(userId: string, title: string): StoredItem {
    const now = nowIso();
    return {
        _id: crypto.randomUUID(),
        userId,
        status: 'inbox',
        title,
        createdTs: now,
        updatedTs: now,
    };
}

// ── Collect ───────────────────────────────────────────────────────────────────

export async function collectItem(db: IDBPDatabase<MyDB>, userId: string, { title, notes }: { title: string; notes?: string }): Promise<StoredItem> {
    const base = buildBaseItem(userId, title);
    // exactOptionalPropertyTypes: omit key rather than assigning undefined
    const item = notes?.trim() ? { ...base, notes: notes.trim() } : base;
    await putItem(db, item);
    await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item });
    return item;
}

// ── Clarify ───────────────────────────────────────────────────────────────────

export interface NextActionMeta {
    workContextIds?: string[];
    peopleIds?: string[];
    energy?: EnergyLevel;
    time?: number;
    focus?: boolean;
    urgent?: boolean;
    expectedBy?: string;
    ignoreBefore?: string;
}

export async function clarifyToNextAction(db: IDBPDatabase<MyDB>, item: StoredItem, meta: NextActionMeta = {}): Promise<StoredItem> {
    // Strip calendar/waitingFor-specific fields that don't apply to nextAction
    const { timeStart: _ts, timeEnd: _te, calendarEventId: _ce, calendarIntegrationId: _ci, waitingForPersonId: _wfp, ...rest } = item;
    const updated: StoredItem = { ...rest, status: 'nextAction', ...meta, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export async function clarifyToCalendar(db: IDBPDatabase<MyDB>, item: StoredItem, timeStart: string, timeEnd: string): Promise<StoredItem> {
    // Strip nextAction/waitingFor-specific fields that don't apply to calendar
    const { workContextIds: _wc, energy: _e, time: _t, focus: _f, urgent: _u, waitingForPersonId: _wfp, ignoreBefore: _ib, ...rest } = item;
    const updated: StoredItem = { ...rest, status: 'calendar', timeStart, timeEnd, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export interface WaitingForMeta {
    waitingForPersonId: string;
    peopleIds?: string[];
    expectedBy?: string;
    ignoreBefore?: string;
}

export async function clarifyToWaitingFor(db: IDBPDatabase<MyDB>, item: StoredItem, meta: WaitingForMeta): Promise<StoredItem> {
    // Strip calendar/nextAction-specific fields that don't apply to waitingFor
    const {
        timeStart: _ts,
        timeEnd: _te,
        calendarEventId: _ce,
        calendarIntegrationId: _ci,
        workContextIds: _wc,
        energy: _e,
        time: _t,
        focus: _f,
        urgent: _u,
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'waitingFor', ...meta, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export async function clarifyToDone(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, status: 'done', updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export async function clarifyToTrash(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, status: 'trash', updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

// ── Generic edit ──────────────────────────────────────────────────────────────

export async function updateItem(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function removeItem(db: IDBPDatabase<MyDB>, itemId: string): Promise<void> {
    await deleteItemById(db, itemId);
    await queueSyncOp(db, { opType: 'delete', entityType: 'item', entityId: itemId, snapshot: null });
}
