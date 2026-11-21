import { z } from 'zod';
import { isClaudeSessionUrl } from '../../lib/claudeRoutine/claudeSessionUrl.js';
import { isoDateTime, nonEmptyString } from './shared.js';

export const CLAUDE_ASK_SUMMARY_MAX_CHARS = 280;

export const claudeAskOutcomeSchema = z.enum(['completed', 'needsInput']);

// Strict, and a strict SUPERSET of ClaudeAskInterface — see the note in itemBrief.ts. Only the
// server writes claudeAsk rows, but the op log replays them to devices and syncDoctor restamps
// them, so the schema still has to accept every stored row.
export const ClaudeAskSnapshotSchema = z
    .object({
        _id: nonEmptyString,
        user: nonEmptyString,
        itemId: nonEmptyString,
        prompt: nonEmptyString,
        sessionId: nonEmptyString,
        // Rendered as a clickable link on every device — https claude.ai only, as a second check
        // behind the start-response validation.
        sessionUrl: z.string().refine(isClaudeSessionUrl, { message: 'sessionUrl must be an https claude.ai link' }),
        result: z
            .object({
                summary: z.string().min(1).max(CLAUDE_ASK_SUMMARY_MAX_CHARS),
                outcome: claudeAskOutcomeSchema,
                reportedTs: isoDateTime,
            })
            .strict()
            .optional(),
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
    })
    .strict();

export const ClaudeAskCreateSchema = z.object({
    entityType: z.literal('claudeAsk'),
    opType: z.literal('create'),
    entityId: nonEmptyString,
    snapshot: ClaudeAskSnapshotSchema,
});

export const ClaudeAskUpdateSchema = z.object({
    entityType: z.literal('claudeAsk'),
    opType: z.literal('update'),
    entityId: nonEmptyString,
    snapshot: ClaudeAskSnapshotSchema,
});

export const ClaudeAskDeleteSchema = z.object({
    entityType: z.literal('claudeAsk'),
    opType: z.literal('delete'),
    entityId: nonEmptyString,
    snapshot: z.null(),
});
