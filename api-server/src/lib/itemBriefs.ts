import dayjs from 'dayjs';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import type { BriefOrigin, ItemBriefInterface, ItemInterface } from '../types/entities.js';
import { applyAndPublishOperation } from './applyOperation.js';
import { type BriefState, briefSourceHash, briefState } from './briefSource.js';

/**
 * Storage ceiling for an authored brief. The model prompt / MCP guidance target ~160 characters
 * (one sentence); 500 is the hard cap so a caller can never stash a second notes field here.
 */
export const BRIEF_MAX_CHARS = 500;

/**
 * SELECTION rule for the `briefState` list filter — distinct from the render rule `briefState()`,
 * which the client mirrors byte-for-byte and must stay untouched. Rendering treats a `skipped`
 * row as "no brief to show"; selecting `none` must NOT re-surface it: the row is the sweeper's
 * recorded decision that the notes are too short, written precisely so the item is not
 * reselected on every pass.
 */
export function matchesBriefStateFilter(item: ItemInterface, brief: ItemBriefInterface | null, wanted: BriefState): boolean {
    if (wanted === 'none' && brief?.origin === 'skipped') {
        return false;
    }
    return briefState(item, brief) === wanted;
}

/** Loads one user's briefs for a page of items in a single `$in` query, keyed by item id. */
export async function loadBriefsByItemId(userId: string, itemIds: string[]): Promise<Map<string, ItemBriefInterface>> {
    if (itemIds.length === 0) {
        return new Map();
    }
    const rows = await itemBriefsDAO.findArray({ user: userId, _id: { $in: itemIds } });
    return new Map(rows.map((row) => [row._id, row]));
}

export function loadBrief(userId: string, itemId: string): Promise<ItemBriefInterface | null> {
    return itemBriefsDAO.findByOwnerAndId(itemId, userId);
}

interface AuthoredBriefWrite {
    userId: string;
    /** The item's persisted id — narrowed by the caller, since `ItemInterface._id` is optional. */
    itemId: string;
    item: ItemInterface;
    text: string;
    origin: Extract<BriefOrigin, 'user' | 'agent'>;
    /** Op-log provenance, e.g. `api:<tokenId>`. */
    deviceId: string;
}

/**
 * Upserts an authored (pinned) brief. `sourceHash` is stamped from the item's CURRENT title +
 * notes so the brief reads as `fresh` until the item changes. Create vs update is decided by
 * the existing row: an `update` op against a missing row would be quarantined as
 * `skipped_missing` by the apply pipeline instead of inserting.
 */
export async function writeAuthoredBrief({ userId, itemId, item, text, origin, deviceId }: AuthoredBriefWrite): Promise<ItemBriefInterface> {
    // Two concurrent first PUTs both read `null` here and both record `create`: harmless — the
    // apply is an upsert and clients treat create/update identically — but the op log will show
    // two creates for one row. A per-item mutex is Phase 2's concern (sweeper vs user writes).
    const existing = await loadBrief(userId, itemId);
    const now = dayjs().toISOString();
    const snapshot: ItemBriefInterface = {
        _id: itemId,
        user: userId,
        itemId,
        text,
        origin,
        sourceHash: briefSourceHash(item.title, item.notes),
        generatedTs: now,
        createdTs: existing?.createdTs ?? now,
        updatedTs: now,
    };
    await applyAndPublishOperation(
        userId,
        { entityType: 'itemBrief', entityId: itemId, opType: existing ? 'update' : 'create', snapshot },
        { deviceId, now, strict: true },
    );
    return snapshot;
}

/** Deletes the brief row with a recorded delete op. Idempotent — a missing row records nothing. */
export async function clearBrief(userId: string, itemId: string, deviceId: string): Promise<void> {
    const existing = await loadBrief(userId, itemId);
    if (!existing) {
        return;
    }
    await applyAndPublishOperation(userId, { entityType: 'itemBrief', entityId: itemId, opType: 'delete', snapshot: null }, { deviceId });
}

type BriefBodyError = { code: 'invalid_body' | 'invalid_brief'; message: string };

/**
 * Parses `{ brief: string | null }`. A string is trimmed; empty-after-trim or over the cap is
 * rejected so the row never stores a blank line or a paragraph. `null` means "clear".
 */
export function parseBriefBody(raw: unknown): { ok: true; value: string | null } | { ok: false; error: BriefBodyError } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('brief' in raw)) {
        return { ok: false, error: { code: 'invalid_body', message: 'request body must be { brief: string | null }' } };
    }
    const { brief } = raw;
    if (brief === null) {
        return { ok: true, value: null };
    }
    if (typeof brief !== 'string') {
        return { ok: false, error: { code: 'invalid_brief', message: 'brief must be a string or null' } };
    }
    const trimmed = brief.trim();
    if (trimmed.length === 0) {
        return { ok: false, error: { code: 'invalid_brief', message: 'brief must not be empty — send null to clear it' } };
    }
    if (trimmed.length > BRIEF_MAX_CHARS) {
        return { ok: false, error: { code: 'invalid_brief', message: `brief is capped at ${BRIEF_MAX_CHARS} characters` } };
    }
    return { ok: true, value: trimmed };
}
