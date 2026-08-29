/**
 * Stamps a browsable `url` deep link onto entity-shaped tool responses, so every MCP client
 * surfaces a clickable link to the item/routine it just touched — no reliance on any user's
 * local Claude memory. This lives in the MCP server so the behaviour ships with the protocol,
 * not with one operator's config.
 *
 * `item`, `routine` and `person` get a link: the web app has per-entity routes for them
 * (`/item/<id>`, `/routine/<id>`, `/person/<id>`). Work contexts have a list-only page, so a
 * per-entity URL would be misleading — they're intentionally skipped.
 *
 * Four response shapes are handled: `one` (a bare entity), `list` (an `{ items|routines: [] }`
 * envelope), `pair` — the `{ head, tail }` composite returned by `gtd_split_routine`, which
 * creates two linkable routines at once — and `batch`, the `{ ok, count, results: [] }` envelope
 * of `gtd_batch`, where each per-op result is stamped from its own `entityType`/`entityId`
 * (delete ops get no url — the row is gone).
 */

/** Web-app path prefix per linkable entity. Keyed by the tool's entity domain. */
const PATH_BY_ENTITY = { item: '/item', routine: '/routine', person: '/person' } as const;
type LinkableEntity = keyof typeof PATH_BY_ENTITY;

/**
 * Maps each tool name to the entity it returns and the response shape, so we stamp the right
 * objects and never touch a non-linkable entity or a status-only payload (delete). Tools
 * absent from this map are passed through untouched.
 */
type ToolShape = { entity: LinkableEntity; shape: 'one' | 'list' | 'pair' } | { shape: 'batch' };

const SHAPE_BY_TOOL: Record<string, ToolShape> = {
    gtd_capture: { entity: 'item', shape: 'one' },
    gtd_get_item: { entity: 'item', shape: 'one' },
    gtd_update_item: { entity: 'item', shape: 'one' },
    gtd_complete_item: { entity: 'item', shape: 'one' },
    gtd_trash_item: { entity: 'item', shape: 'one' },
    gtd_list_items: { entity: 'item', shape: 'list' },
    gtd_create_routine: { entity: 'routine', shape: 'one' },
    gtd_get_routine: { entity: 'routine', shape: 'one' },
    gtd_update_routine: { entity: 'routine', shape: 'one' },
    gtd_pause_routine: { entity: 'routine', shape: 'one' },
    gtd_resume_routine: { entity: 'routine', shape: 'one' },
    // Split returns a { head, tail } composite (two routines), not a bare routine — see stampPair.
    gtd_split_routine: { entity: 'routine', shape: 'pair' },
    gtd_list_routines: { entity: 'routine', shape: 'list' },
    gtd_create_person: { entity: 'person', shape: 'one' },
    gtd_get_person: { entity: 'person', shape: 'one' },
    gtd_update_person: { entity: 'person', shape: 'one' },
    gtd_list_people: { entity: 'person', shape: 'list' },
    // Batch returns per-op results (not entities); each is stamped from its own entityType.
    gtd_batch: { shape: 'batch' },
};

/** The array property holding the entities in a list response (mirrors the v1 API envelopes). */
const LIST_KEY_BY_ENTITY: Record<LinkableEntity, 'items' | 'routines' | 'people'> = { item: 'items', routine: 'routines', person: 'people' };

/**
 * Returns a shallow copy of `result` with `url` stamped onto the entity (or each entity in a
 * list). Returns `result` unchanged when the web base is unknown, the tool isn't entity-shaped,
 * or the payload doesn't match the expected shape (defensive against API envelope drift).
 */
export function decorateWithUrls(toolName: string, result: unknown, webBase: string | null): unknown {
    const spec = SHAPE_BY_TOOL[toolName];
    if (!webBase || !spec) {
        return result;
    }
    if (spec.shape === 'batch') {
        return stampBatchResults(result, webBase);
    }
    if (spec.shape === 'one') {
        return stampOne(result, spec.entity, webBase);
    }
    if (spec.shape === 'pair') {
        return stampPair(result, spec.entity, webBase);
    }
    return stampList(result, spec.entity, webBase);
}

/** Stamps `url` onto each named entity of a `{ head, tail }` composite (gtd_split_routine). */
function stampPair(envelope: unknown, kind: LinkableEntity, webBase: string): unknown {
    if (!isRecord(envelope)) {
        return envelope;
    }
    const { head, tail } = envelope;
    return {
        ...envelope,
        ...(head !== undefined ? { head: stampOne(head, kind, webBase) } : {}),
        ...(tail !== undefined ? { tail: stampOne(tail, kind, webBase) } : {}),
    };
}

function stampOne(entity: unknown, kind: LinkableEntity, webBase: string): unknown {
    if (!isRecord(entity)) {
        return entity;
    }
    const { _id } = entity;
    if (typeof _id !== 'string' || _id.length === 0) {
        return entity;
    }
    return { ...entity, url: `${webBase}${PATH_BY_ENTITY[kind]}/${_id}` };
}

function stampList(envelope: unknown, kind: LinkableEntity, webBase: string): unknown {
    if (!isRecord(envelope)) {
        return envelope;
    }
    const listKey = LIST_KEY_BY_ENTITY[kind];
    const list = envelope[listKey];
    if (!Array.isArray(list)) {
        return envelope;
    }
    return { ...envelope, [listKey]: list.map((entity) => stampOne(entity, kind, webBase)) };
}

/** Stamps `url` onto each per-op result of the `gtd_batch` response envelope. */
function stampBatchResults(envelope: unknown, webBase: string): unknown {
    if (!isRecord(envelope)) {
        return envelope;
    }
    // Bracket access required by `noPropertyAccessFromIndexSignature` on the Record type;
    // suppress Biome's dot-notation preference, which would conflict with tsc.
    // biome-ignore lint/complexity/useLiteralKeys: see above.
    const results = envelope['results'];
    if (!Array.isArray(results)) {
        return envelope;
    }
    return { ...envelope, results: results.map((result) => stampBatchResult(result, webBase)) };
}

function stampBatchResult(result: unknown, webBase: string): unknown {
    if (!isRecord(result)) {
        return result;
    }
    const { entityType, entityId, opType } = result;
    // Deletes have no page to link; workContext has a list-only page (see header comment).
    if (opType === 'delete' || typeof entityId !== 'string' || entityId.length === 0 || !isLinkableEntity(entityType)) {
        return result;
    }
    return { ...result, url: `${webBase}${PATH_BY_ENTITY[entityType]}/${entityId}` };
}

function isLinkableEntity(value: unknown): value is LinkableEntity {
    return typeof value === 'string' && value in PATH_BY_ENTITY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
