import { z } from 'zod';
import { isoDateTime, nonEmptyString } from './shared.js';

export const ReviewInboxSnapshotSchema = z
    .object({
        _id: nonEmptyString,
        user: nonEmptyString,
        name: z.string(),
        // Required, mirroring ReviewInboxInterface: a snapshot missing `order` must fail strict
        // validation rather than silently clearing the checklist ordering under full-snapshot LWW.
        order: z.number(),
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
    })
    .strict();

export const ReviewInboxCreateSchema = z.object({
    entityType: z.literal('reviewInbox'),
    opType: z.literal('create'),
    entityId: nonEmptyString,
    snapshot: ReviewInboxSnapshotSchema,
});

export const ReviewInboxUpdateSchema = z.object({
    entityType: z.literal('reviewInbox'),
    opType: z.literal('update'),
    entityId: nonEmptyString,
    snapshot: ReviewInboxSnapshotSchema,
});

export const ReviewInboxDeleteSchema = z.object({
    entityType: z.literal('reviewInbox'),
    opType: z.literal('delete'),
    entityId: nonEmptyString,
    snapshot: z.null(),
});
