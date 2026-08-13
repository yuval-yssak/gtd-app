import type { EntityMoveReceiptInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

/** Composite key so the receipt upsert is idempotent per (entity, from, to) triple. */
export function entityMoveReceiptId(entityId: string, fromUserId: string, toUserId: string): string {
    return `${entityId}::${fromUserId}::${toUserId}`;
}

/**
 * Move receipts — the positive provenance behind the reassign already-moved idempotency branch.
 * Written BEFORE the atomic owner flip (a claim of intent, not of applied state), so a retry
 * after a crash between the flip and the op-log inserts can prove "THIS caller moved this entity"
 * rather than inferring it from post-state shape. Without the receipt, "not under fromUserId but
 * present under toUserId" is equally true of an entity toUserId has always owned — and answering
 * `alreadyMoved` there would forge op-log legs on both users and leak the target's snapshot.
 */
class EntityMovesDAO extends AbstractDAO<EntityMoveReceiptInterface> {
    override COLLECTION_NAME = 'entityMoves';
}

export default new EntityMovesDAO();
