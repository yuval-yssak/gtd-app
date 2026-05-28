import type { MongoClient } from 'mongodb';
import type { RoutineInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class RoutinesDAO extends AbstractDAO<RoutineInterface> {
    override COLLECTION_NAME = 'routines';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, updatedTs: 1 } }, // used by sync: pull all routines changed since last device sync
        ]);
    }

    /**
     * Builds the unique partial index that forbids two ACTIVE routines on the same GCal recurring
     * series. Kept OUT of `init` and called only after `dedupeActiveRoutinesPerGCalSeries` has run,
     * because `createIndexes` rejects (and would crash boot) if pre-existing data already violates it.
     * Partial on active:true so historical inactive duplicates don't violate it; `calendarEventId:
     * { $type: 'string' }` keeps in-app routines out — they either omit the field OR store an explicit
     * `null` (observed in real data), and `$type: 'string'` excludes both, where `$exists: true` would
     * wrongly fold all null-valued in-app routines under one index key and collide. Mirrors the items
     * `calendarInstanceEventId` index, which uses the same `$type: 'string'` guard for this reason.
     */
    async ensureUniqueActiveSeriesIndex() {
        await this._collection.createIndexes([
            {
                key: { user: 1, calendarEventId: 1, calendarIntegrationId: 1 },
                unique: true,
                partialFilterExpression: { active: true, calendarEventId: { $type: 'string' } },
                name: 'uniq_active_routine_per_gcal_series',
            },
        ]);
    }
}

export default new RoutinesDAO();
