import dayjs from 'dayjs';
import itemsDAO from '../dataAccess/itemsDAO.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';
import { notifyChange } from './notifyChange.js';
import { recordOperation } from './operationHelpers.js';

/**
 * When a person or workContext is deleted, items that referenced it would otherwise carry a
 * dangling id — UI lists silently drop the chip / show "missing person", and the user has no
 * record of what the reference *was*. These helpers do two things:
 *
 *   1. Strip the dangling reference from each affected item (`$pull` from arrays / `$unset`
 *      the scalar `waitingForPersonId`).
 *   2. Append a human-readable breadcrumb to the item title — e.g. `[person removed: Jane Doe]` —
 *      so the deleted ref stays visible on every list view. The name is captured at delete time
 *      so renames or id-reuse later don't poison the audit trail.
 *
 * Cascades run for ALL items including done/trash (per product decision: the breadcrumb is the
 * permanent record, archived items deserve it too). Each item gets a fresh `update` op recorded
 * so SSE, web push, and webhooks see the change uniformly. GCal pushback is suppressed: the
 * breadcrumb is a GTD-side artifact and shouldn't pollute calendar event titles.
 *
 * Mutations are atomic per item via MongoDB `$pull` / `$unset` / `$set`, not snapshot-LWW
 * through the apply pipeline — that protects concurrent edits on unrelated fields (e.g. a
 * `notes` edit landing between our find and update) from being clobbered.
 *
 * Idempotent: re-running a cascade for the same (entityId, kind) won't double-append breadcrumbs
 * — the title-presence check below short-circuits.
 */

const DEVICE_ID = 'server:reference-cascade';

/**
 * Strip a deleted person id from every referencing item and append a breadcrumb to each title.
 * Two reference shapes on the item:
 *   - `peopleIds[]`  — generic association (nextAction + waitingFor items both use this)
 *   - `waitingForPersonId` — the specific person a `waitingFor` item is waiting on (scalar)
 *
 * An item carrying both shapes for the same personId receives both breadcrumb tags, so the user
 * can tell which kind of reference is being preserved.
 */
export async function cascadePersonReferenceRemoval(userId: string, personId: string, personName: string): Promise<void> {
    const affected = await itemsDAO.findArray({
        user: userId,
        $or: [{ peopleIds: personId }, { waitingForPersonId: personId }],
    } as never);
    for (const item of affected) {
        await applyPersonRemoval(item, userId, personId, personName);
    }
}

/**
 * Strip a deleted workContext id from every referencing item (`workContextIds[]`) and append a
 * `[context removed: …]` breadcrumb to each title.
 */
export async function cascadeWorkContextReferenceRemoval(userId: string, contextId: string, contextName: string): Promise<void> {
    const affected = await itemsDAO.findArray({
        user: userId,
        workContextIds: contextId,
    } as never);
    for (const item of affected) {
        await applyWorkContextRemoval(item, userId, contextId, contextName);
    }
}

async function applyPersonRemoval(item: ItemInterface, userId: string, personId: string, personName: string): Promise<void> {
    if (!item._id) {
        return;
    }
    const hadInArray = item.peopleIds?.includes(personId) ?? false;
    const wasWaitingFor = item.waitingForPersonId === personId;
    if (!hadInArray && !wasWaitingFor) {
        return;
    }
    let newTitle = item.title;
    if (hadInArray) {
        newTitle = appendBreadcrumb(newTitle, `person removed: ${personName}`);
    }
    if (wasWaitingFor) {
        newTitle = appendBreadcrumb(newTitle, `was waiting for: ${personName}`);
    }
    const now = dayjs().toISOString();
    // Title is recomputed from a stale read: a concurrent title edit landing between the
    // findArray above and this updateOne will be clobbered. Title-race is the deliberate
    // trade-off for keeping the breadcrumb composition off the Mongo wire; concurrent edits on
    // other fields (notes, status, etc.) survive because we only $set the fields we own.
    const update: { $set: Record<string, unknown>; $pull?: Record<string, unknown>; $unset?: Record<string, ''> } = {
        $set: { title: newTitle, updatedTs: now },
    };
    if (hadInArray) {
        update.$pull = { peopleIds: personId };
    }
    if (wasWaitingFor) {
        update.$unset = { waitingForPersonId: '' };
    }
    await itemsDAO.updateOne({ _id: item._id, user: userId } as never, update);
    // Empty peopleIds arrays are not the same as missing — `$pull` of the last element leaves
    // `peopleIds: []`. Remove the empty array so downstream consumers can do truthy checks.
    await itemsDAO.updateOne({ _id: item._id, user: userId, peopleIds: { $size: 0 } } as never, { $unset: { peopleIds: '' } } as never);

    await publishCascadeUpdate(userId, item._id, now);
}

async function applyWorkContextRemoval(item: ItemInterface, userId: string, contextId: string, contextName: string): Promise<void> {
    if (!item._id) {
        return;
    }
    if (!item.workContextIds?.includes(contextId)) {
        return;
    }
    const newTitle = appendBreadcrumb(item.title, `context removed: ${contextName}`);
    const now = dayjs().toISOString();
    await itemsDAO.updateOne(
        { _id: item._id, user: userId } as never,
        {
            $set: { title: newTitle, updatedTs: now },
            $pull: { workContextIds: contextId },
        } as never,
    );
    await itemsDAO.updateOne({ _id: item._id, user: userId, workContextIds: { $size: 0 } } as never, { $unset: { workContextIds: '' } } as never);

    await publishCascadeUpdate(userId, item._id, now);
}

/**
 * Re-reads the item post-mutation and emits the standard `update` op + SSE/push fan-out so other
 * devices learn about the change. GCal pushback is suppressed — the breadcrumb is a GTD-side
 * artifact and shouldn't be echoed into Google Calendar event titles.
 */
async function publishCascadeUpdate(userId: string, itemId: string, now: string): Promise<void> {
    const updated = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!updated) {
        // Another device deleted this item between our find and update — nothing to publish.
        return;
    }
    const op = await recordOperation(userId, {
        entityType: 'item',
        entityId: itemId,
        opType: 'update',
        snapshot: updated,
        now,
        deviceId: DEVICE_ID,
    });
    await notifyChange(op, { suppressGCalPushback: true });
}

/**
 * Appends ` [<tag>]` to the title, unless the exact tag is already present — keeps the cascade
 * idempotent under retries (delete-after-delete, replayed sync ops) and avoids cluttering titles
 * if a person/context with the same name is deleted twice (e.g. re-created with the same name
 * after a prior cascade ran).
 */
function appendBreadcrumb(title: string, tag: string): string {
    const fragment = `[${tag}]`;
    if (title.includes(fragment)) {
        return title;
    }
    return `${title} ${fragment}`;
}

/**
 * Fan-out hook invoked from the pipeline after a `person` or `workContext` delete op has been
 * persisted. Reads `entityType` + the (hydrated) pre-delete snapshot off the op to drive the
 * correct cascade. No-ops for any other entity / opType.
 *
 * Best-effort: a cascade failure logs but does not throw — the original delete has already been
 * persisted + fan-out has fired for the deleted entity itself, and unwinding that would create
 * worse divergence than a one-time broken reference.
 */
export async function maybeCascadeReferenceRemoval(op: OperationInterface): Promise<void> {
    if (op.opType !== 'delete' || !op.snapshot) {
        return;
    }
    try {
        if (op.entityType === 'person') {
            const snapshot = op.snapshot as { _id: string; name: string };
            await cascadePersonReferenceRemoval(op.user, snapshot._id, snapshot.name);
            return;
        }
        if (op.entityType === 'workContext') {
            const snapshot = op.snapshot as { _id: string; name: string };
            await cascadeWorkContextReferenceRemoval(op.user, snapshot._id, snapshot.name);
        }
    } catch (err) {
        console.error('[reference-cascade] failed; references may dangle', { opId: op._id, entityType: op.entityType, entityId: op.entityId, err });
    }
}
