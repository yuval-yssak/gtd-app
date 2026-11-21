import dayjs from 'dayjs';
import { z } from 'zod';
import claudeRoutineConnectionsDAO from '../../dataAccess/claudeRoutineConnectionsDAO.js';
import type { ClaudeRoutineConnectionInterface } from '../../types/entities.js';
import { decrypt, encrypt } from '../tokenEncryption.js';

const ConnectionBodySchema = z.object({
    claudeRoutineId: z
        .string()
        .trim()
        .regex(/^trig_[A-Za-z0-9_-]{1,200}$/),
    token: z
        .string()
        .trim()
        .regex(/^sk-ant-oat01-[A-Za-z0-9_-]{10,500}$/),
});

export type ClaudeRoutineConnectionInput = z.infer<typeof ConnectionBodySchema>;

export type ConnectionBodyParse =
    | { ok: true; input: ClaudeRoutineConnectionInput }
    | { ok: false; code: 'invalid_claude_routine_id' | 'invalid_claude_routine_token'; message: string };

/** Validates a Settings submission. Shapes only — whether the token works shows on the first ask. */
export function parseConnectionBody(raw: unknown): ConnectionBodyParse {
    const parsed = ConnectionBodySchema.safeParse(raw);
    if (parsed.success) {
        return { ok: true, input: parsed.data };
    }
    const isIdProblem = parsed.error.issues.some((issue) => issue.path[0] === 'claudeRoutineId' || issue.path.length === 0);
    return isIdProblem
        ? { ok: false, code: 'invalid_claude_routine_id', message: 'claudeRoutineId must look like trig_…' }
        : { ok: false, code: 'invalid_claude_routine_token', message: 'token must look like sk-ant-oat01-…' };
}

/** What Settings may see: never the token, only its last four characters. */
export interface ClaudeRoutineConnectionView {
    connected: boolean;
    claudeRoutineId?: string;
    tokenHint?: string;
    updatedTs?: string;
}

export function presentConnection(row: ClaudeRoutineConnectionInterface | null): ClaudeRoutineConnectionView {
    if (!row) {
        return { connected: false };
    }
    return { connected: true, claudeRoutineId: row.claudeRoutineId, tokenHint: row.tokenHint, updatedTs: row.updatedTs };
}

export function loadConnection(userId: string): Promise<ClaudeRoutineConnectionInterface | null> {
    return claudeRoutineConnectionsDAO.findOne({ user: userId });
}

/** Stores (or replaces) the user's Claude routine, encrypting the token at rest. */
export async function saveConnection(userId: string, input: ClaudeRoutineConnectionInput): Promise<ClaudeRoutineConnectionInterface> {
    const now = dayjs().toISOString();
    const existing = await loadConnection(userId);
    // One row per user, keyed by the user id, so a replace is a plain id-keyed upsert.
    const row: ClaudeRoutineConnectionInterface = {
        _id: userId,
        user: userId,
        claudeRoutineId: input.claudeRoutineId,
        tokenEncrypted: encrypt(input.token),
        tokenHint: input.token.slice(-4),
        createdTs: existing?.createdTs ?? now,
        updatedTs: now,
    };
    await claudeRoutineConnectionsDAO.replaceById(userId, row);
    return row;
}

export async function deleteConnection(userId: string): Promise<void> {
    await claudeRoutineConnectionsDAO.deleteByOwner(userId, userId);
}

export function connectionToken(row: ClaudeRoutineConnectionInterface): string {
    return decrypt(row.tokenEncrypted);
}
