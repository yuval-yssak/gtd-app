import { z } from 'zod';
import { isoDateTime, nonEmptyString } from './shared.js';

export const briefOriginSchema = z.enum(['model', 'user', 'agent', 'skipped']);

// Strict, and a strict SUPERSET of ItemBriefInterface (every optional field allowed): a snapshot
// schema narrower than the entity interface jams every client push queue that round-trips a
// stored row (the /sync/push routine-schema incident). Keep the two in lockstep.
export const ItemBriefSnapshotSchema = z
    .object({
        _id: nonEmptyString,
        user: nonEmptyString,
        itemId: nonEmptyString,
        text: z.string().nullable(),
        origin: briefOriginSchema,
        sourceHash: nonEmptyString,
        model: z.string().optional(),
        generatedTs: isoDateTime,
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
    })
    .strict()
    // `_id` and `itemId` are the same key by design (one brief per item) — a row where they
    // diverge would be reachable by one lookup path and invisible to the other.
    .refine((snapshot) => snapshot._id === snapshot.itemId, { message: 'itemId must equal _id', path: ['itemId'] });

export const ItemBriefCreateSchema = z.object({
    entityType: z.literal('itemBrief'),
    opType: z.literal('create'),
    entityId: nonEmptyString,
    snapshot: ItemBriefSnapshotSchema,
});

export const ItemBriefUpdateSchema = z.object({
    entityType: z.literal('itemBrief'),
    opType: z.literal('update'),
    entityId: nonEmptyString,
    snapshot: ItemBriefSnapshotSchema,
});

export const ItemBriefDeleteSchema = z.object({
    entityType: z.literal('itemBrief'),
    opType: z.literal('delete'),
    entityId: nonEmptyString,
    snapshot: z.null(),
});
