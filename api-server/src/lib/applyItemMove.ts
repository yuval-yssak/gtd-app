import dayjs from 'dayjs';
import itemsDAO from '../dataAccess/itemsDAO.js';
import type { ItemInterface } from '../types/entities.js';
import { applyAndPublishOperationWithOutcome } from './applyOperation.js';
import { anchorIdOf, type MovePlan, type MoveTarget, planItemMove, type RankWrite, rankSectionKeyOf, rowMissingFromSection } from './itemMove.js';
import { KeyedMutex } from './keyedMutex.js';
import { resolveUserTimezone } from './userTimezone.js';

export interface MoveItemRequest {
    userId: string;
    tokenId: string;
    itemId: string;
    target: MoveTarget;
}

type MoveErrorCode = 'not_found' | 'anchor_not_found' | 'invalid_anchor' | 'not_orderable' | 'different_section' | 'item_changed';

export type MoveItemResult =
    | { ok: true; item: ItemInterface; placement: Pick<MovePlan, 'position' | 'total'>; isNoop: boolean }
    | { ok: false; status: 400 | 404 | 409; code: MoveErrorCode; message: string };

type MoveError = Extract<MoveItemResult, { ok: false }>;

type IdentifiedItem = ItemInterface & { _id: string };

const DIFFERENT_SECTION: MoveError = {
    ok: false,
    status: 409,
    code: 'different_section',
    message: 'the anchor is not in the same ordered section (status and expected day) as the item',
};

const ITEM_CHANGED: MoveError = {
    ok: false,
    status: 409,
    code: 'item_changed',
    message: 'the item changed while it was being moved; read it again and retry',
};

// One move at a time per user: parallel moves (an agent's parallel tool calls) would otherwise read
// the same keys and mint equal ones, or interleave two re-keys of the same run. One Cloud Run
// instance, so an in-process lock is the whole story.
const moveLock = new KeyedMutex();

/** A loaded row whose section is known — the unit every check below works on. */
interface SectionedItem {
    row: IdentifiedItem;
    sectionKey: string;
}

function withId(row: ItemInterface): IdentifiedItem | null {
    return row._id ? { ...row, _id: row._id } : null;
}

async function loadSectioned(userId: string, itemId: string, timeZone: string): Promise<SectionedItem | 'missing' | 'unordered'> {
    const found = await itemsDAO.findByOwnerAndId(itemId, userId);
    const row = found ? withId(found) : null;
    if (!row) {
        return 'missing';
    }
    const sectionKey = rankSectionKeyOf(row, timeZone);
    return sectionKey === null ? 'unordered' : { row, sectionKey };
}

/** Validates the anchor of a before/after move: an existing row of the user's, not the item itself, in the same section. */
async function checkAnchor(request: MoveItemRequest, moved: SectionedItem, timeZone: string): Promise<MoveError | null> {
    const anchorId = anchorIdOf(request.target);
    if (anchorId === null) {
        return null;
    }
    if (anchorId === request.itemId) {
        return { ok: false, status: 400, code: 'invalid_anchor', message: 'an item cannot be moved relative to itself' };
    }
    const anchor = await loadSectioned(request.userId, anchorId, timeZone);
    if (anchor === 'missing') {
        return { ok: false, status: 404, code: 'anchor_not_found', message: 'anchor item not found' };
    }
    return anchor === 'unordered' || anchor.sectionKey !== moved.sectionKey ? DIFFERENT_SECTION : null;
}

/** Every row of the user's that shares the moved row's section — tickler-hidden rows included, they share the keyspace. */
async function sectionRows(moved: SectionedItem, timeZone: string): Promise<IdentifiedItem[]> {
    const sameStatus = await itemsDAO.findArray({ user: moved.row.user, status: moved.row.status });
    return sameStatus.flatMap((row) => {
        const identified = withId(row);
        return identified && rankSectionKeyOf(identified, timeZone) === moved.sectionKey ? [identified] : [];
    });
}

function snapshotsFor(rows: readonly IdentifiedItem[], writes: readonly RankWrite[], now: string): IdentifiedItem[] {
    const byId = new Map(rows.map((row) => [row._id, row]));
    return writes.map((write) => {
        const row = byId.get(write.id);
        if (!row) {
            throw new Error(`move plan names row ${write.id}, which is not in the section`);
        }
        return { ...row, rank: write.rank, updatedTs: now };
    });
}

/**
 * Writes each re-key as a full-snapshot update op through the shared pipeline (LWW, fan-out to
 * devices), in plan order. Stops at the first write the collection did not accept (row deleted or
 * newer meanwhile) and reports it — answering 200 with a rank that never landed would lie. Re-keys
 * written before a refused write stay (accepted: it takes a concurrent edit mid-move, and the next
 * move or drag re-keys the run again).
 */
async function writeRanks(request: MoveItemRequest, snapshots: readonly IdentifiedItem[], now: string): Promise<boolean> {
    for (const snapshot of snapshots) {
        const { outcome } = await applyAndPublishOperationWithOutcome(
            request.userId,
            { entityType: 'item', opType: 'update', entityId: snapshot._id, snapshot },
            // Not strict: the snapshot is the stored row with only `rank` changed, so a strict refusal could
            // only come from a legacy neighbour row — that must not block reordering the rows around it.
            { deviceId: `api:${request.tokenId}`, now },
        );
        if (outcome !== 'applied') {
            return false;
        }
    }
    return true;
}

async function moveWithinSection(request: MoveItemRequest, moved: SectionedItem, timeZone: string): Promise<MoveItemResult> {
    const rows = await sectionRows(moved, timeZone);
    // The item or the anchor can be completed, re-dated or deleted between the checks above and this read.
    const missing = rowMissingFromSection(rows, request.itemId, request.target);
    if (missing !== null) {
        return missing === 'item' ? ITEM_CHANGED : DIFFERENT_SECTION;
    }
    const plan = planItemMove(rows, request.itemId, request.target);
    const now = dayjs().toISOString();
    const snapshots = snapshotsFor(rows, plan.writes, now);
    if (!(await writeRanks(request, snapshots, now))) {
        return ITEM_CHANGED;
    }
    const item = snapshots.find((row) => row._id === request.itemId) ?? rows.find((row) => row._id === request.itemId) ?? moved.row;
    return { ok: true, item, placement: { position: plan.position, total: plan.total }, isNoop: plan.writes.length === 0 };
}

async function moveItemUnlocked(request: MoveItemRequest): Promise<MoveItemResult> {
    const timeZone = await resolveUserTimezone(request.userId);
    const moved = await loadSectioned(request.userId, request.itemId, timeZone);
    if (moved === 'missing') {
        return { ok: false, status: 404, code: 'not_found', message: 'item not found' };
    }
    if (moved === 'unordered') {
        return { ok: false, status: 409, code: 'not_orderable', message: 'only inbox, nextAction, waitingFor and somedayMaybe items have a manual order' };
    }
    const anchorError = await checkAnchor(request, moved, timeZone);
    return anchorError ?? moveWithinSection(request, moved, timeZone);
}

/**
 * Moves one item inside its rank section (`rankSectionKeyOf`) to the top, the bottom, or just
 * before/after another item of the same section. Writes only `rank` (never status or date) — on
 * the happy path one op on the moved row; neighbours are re-keyed only when they are unranked or
 * out of order around the slot, the whole section when a key grew too long (`planItemMove`).
 */
export function moveItem(request: MoveItemRequest): Promise<MoveItemResult> {
    return moveLock.withLock(request.userId, () => moveItemUnlocked(request));
}
