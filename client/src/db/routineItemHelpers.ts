import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { computeNextOccurrence } from '../lib/rruleUtils';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { putItem } from './itemHelpers';
import { queueSyncOp } from './syncHelpers';

/**
 * Create the next nextAction item for a routine, scheduling it for the first rrule occurrence
 * after completionDate. Called whenever a routine-linked item is marked done or trashed,
 * regardless of the item's current status — this ensures continuity even if the item was
 * transformed to inbox/calendar/waitingFor before being completed.
 */
export async function createNextRoutineItem(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine, completionDate: Date): Promise<void> {
    const nextDueDate = computeNextOccurrence(routine.rrule, completionDate);
    const expectedBy = dayjs(nextDueDate).format('YYYY-MM-DD');

    // Tickler: hide the item until (expectedBy - ticklerLeadDays) so it only surfaces when actionable.
    const { ticklerLeadDays } = routine.template;
    const ignoreBefore = ticklerLeadDays !== undefined ? dayjs(nextDueDate).subtract(ticklerLeadDays, 'day').format('YYYY-MM-DD') : undefined;

    const now = dayjs().toISOString();
    const item = {
        _id: crypto.randomUUID(),
        userId,
        status: 'nextAction' as const,
        title: routine.title,
        routineId: routine._id,
        expectedBy,
        ...(ignoreBefore !== undefined ? { ignoreBefore } : {}),
        ...(routine.template.workContextIds ? { workContextIds: routine.template.workContextIds } : {}),
        ...(routine.template.peopleIds ? { peopleIds: routine.template.peopleIds } : {}),
        ...(routine.template.energy ? { energy: routine.template.energy } : {}),
        ...(routine.template.time !== undefined ? { time: routine.template.time } : {}),
        ...(routine.template.focus !== undefined ? { focus: routine.template.focus } : {}),
        ...(routine.template.urgent !== undefined ? { urgent: routine.template.urgent } : {}),
        ...(routine.template.notes ? { notes: routine.template.notes } : {}),
        createdTs: now,
        updatedTs: now,
    };

    await putItem(db, item);
    await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item });
}
