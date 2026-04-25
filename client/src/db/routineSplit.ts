import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { IDBPDatabase } from 'idb';
import { addUntilToRrule } from '../lib/routineSplitUtils';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { putRoutine } from './routineHelpers';
import { createNextRoutineItem, deleteFutureItemsFromDate, generateCalendarItemsToHorizon } from './routineItemHelpers';
import { updateRoutine } from './routineMutations';
import { queueSyncOp } from './syncHelpers';

dayjs.extend(utc);

/**
 * Split a routine at `splitDate`: cap the original with UNTIL and mark it inactive, delete
 * its future items from that date, create a new tail routine with the edited properties,
 * and seed the tail's first item(s). Works for both `calendar` and `nextAction` routines —
 * calendar tails generate items up to the horizon; nextAction tails seed exactly one pending
 * item (or skip generation when the tail's startDate is in the future — the boot-tick will
 * materialize it).
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
        ...(editedFields.startDate ? { startDate: editedFields.startDate } : {}),
    };
    await putRoutine(db, tail);
    await queueSyncOp(db, { opType: 'create', entityType: 'routine', entityId: tail._id, snapshot: tail });

    // 4. Seed the tail's first item(s). Calendar tails generate up to the horizon; nextAction
    //    tails seed one pending occurrence (unless startDate is future — the boot-tick handles it).
    await seedTailFirstItems(db, userId, tail);

    return tail;
}

async function seedTailFirstItems(db: IDBPDatabase<MyDB>, userId: string, tail: StoredRoutine): Promise<void> {
    if (tail.routineType === 'calendar') {
        await generateCalendarItemsToHorizon(db, userId, tail);
        return;
    }
    // nextAction: skip when startDate is in the future — boot-tick materializes it on the day.
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    if (tail.startDate && tail.startDate > todayStr) {
        return;
    }
    await createNextRoutineItem(db, userId, tail, dayjs().toDate());
}
