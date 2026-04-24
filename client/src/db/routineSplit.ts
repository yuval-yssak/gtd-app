import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { IDBPDatabase } from 'idb';
import { addUntilToRrule } from '../lib/routineSplitUtils';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { putRoutine } from './routineHelpers';
import { deleteFutureItemsFromDate, generateCalendarItemsToHorizon } from './routineItemHelpers';
import { updateRoutine } from './routineMutations';
import { queueSyncOp } from './syncHelpers';

dayjs.extend(utc);

/**
 * Split a calendar routine at `splitDate`: cap the original with UNTIL and mark it
 * inactive, delete its future items from that date, create a new tail routine with
 * the edited properties, and generate items for it.
 */
export async function splitRoutine(
    db: IDBPDatabase<MyDB>,
    userId: string,
    original: StoredRoutine,
    editedFields: Omit<StoredRoutine, '_id' | 'userId' | 'createdTs' | 'updatedTs' | 'active'>,
    splitDate: string,
): Promise<StoredRoutine> {
    const now = dayjs().toISOString();

    // 1. Cap the original routine's rrule with UNTIL. Prune exceptions that reference dates
    //    the capped routine no longer generates — otherwise they're orphaned references to
    //    never-materialized instances and drift through sync forever.
    const cappedRrule = addUntilToRrule(original.rrule, splitDate);
    const { routineExceptions: existingExceptions, ...rest } = original;
    const keptExceptions = (existingExceptions ?? []).filter((exc) => exc.date < splitDate);
    const cappedOriginal: StoredRoutine = {
        ...rest,
        rrule: cappedRrule,
        active: false,
        ...(keptExceptions.length > 0 ? { routineExceptions: keptExceptions } : {}),
    };
    await updateRoutine(db, cappedOriginal);

    // 2. Delete future items from the original after the split point
    await deleteFutureItemsFromDate(db, userId, original._id, splitDate);

    // 3. Create the tail routine — createdTs = splitDate to anchor DTSTART.
    //    Build explicitly to avoid carrying over original-series fields like calendarEventId.
    const tail: StoredRoutine = {
        _id: crypto.randomUUID(),
        userId,
        title: editedFields.title,
        routineType: editedFields.routineType,
        rrule: editedFields.rrule,
        template: editedFields.template,
        active: true,
        splitFromRoutineId: original._id,
        createdTs: dayjs.utc(splitDate).startOf('day').toISOString(),
        updatedTs: now,
        ...(editedFields.calendarItemTemplate ? { calendarItemTemplate: editedFields.calendarItemTemplate } : {}),
        ...(editedFields.calendarIntegrationId ? { calendarIntegrationId: editedFields.calendarIntegrationId } : {}),
        ...(editedFields.calendarSyncConfigId ? { calendarSyncConfigId: editedFields.calendarSyncConfigId } : {}),
    };
    await putRoutine(db, tail);
    await queueSyncOp(db, { opType: 'create', entityType: 'routine', entityId: tail._id, snapshot: tail });

    // 4. Generate calendar items for the tail
    await generateCalendarItemsToHorizon(db, userId, tail);

    return tail;
}
