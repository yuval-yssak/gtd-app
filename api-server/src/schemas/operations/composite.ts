import { z } from 'zod';
import { entityTypeSchema, nonEmptyString } from './shared.js';

// Composite operations are server-orchestrated transactions that decompose into multiple primitive
// ops. Schemas live here so the public-API routes that accept them can validate up-front before
// the orchestrator runs.

export const RoutinePauseSchema = z.object({
    entityType: z.literal('routine'),
    opType: z.literal('pause'),
    entityId: nonEmptyString,
});

export const RoutineResumeSchema = z.object({
    entityType: z.literal('routine'),
    opType: z.literal('resume'),
    entityId: nonEmptyString,
});

export const RoutineSplitSchema = z.object({
    entityType: z.literal('routine'),
    opType: z.literal('split'),
    entityId: nonEmptyString,
    // Split-from date and the head/tail edits — exact shape mirrors `client/src/db/routineSplit.ts`.
    // Kept loose here as a placeholder until the server-side orchestrator port lands; tightened in
    // Phase 2 when the route ships.
    splitDate: z.string().min(1),
    tailPatch: z.record(z.string(), z.unknown()).optional(),
});

export const ReassignSchema = z.object({
    entityType: entityTypeSchema,
    entityId: nonEmptyString,
    fromUserId: nonEmptyString,
    toUserId: nonEmptyString,
    editPatch: z.record(z.string(), z.unknown()).optional(),
});
