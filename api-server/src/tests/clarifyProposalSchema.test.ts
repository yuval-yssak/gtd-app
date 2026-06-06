import { describe, expect, it } from 'vitest';
import { CLARIFY_PROPOSAL_SCHEMA, PROPOSABLE_ITEM_FIELDS } from '../lib/claude/proposalSchema.js';

/**
 * Guards the structural contract the Anthropic structured-output validator enforces: a strict
 * json_schema has no notion of an OPTIONAL property — every key under `properties` must also appear
 * in `required`, or the request is rejected `invalid_request_error: "Schema is too complex."` (which
 * the assist route maps to a 502). A live reproduction confirmed the original schema — which left
 * `required` off the patch object — produced exactly that. These assertions fail fast in CI if a
 * future edit reintroduces an unrequired property anywhere in the tree.
 */

type JsonSchemaNode = {
    type?: string;
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    items?: JsonSchemaNode;
    anyOf?: JsonSchemaNode[];
};

/** Every object node must list ALL of its property keys in `required`. Recurses through anyOf/items. */
function everyPropertyRequired(node: JsonSchemaNode, path = 'root'): void {
    if (node.anyOf) {
        node.anyOf.forEach((branch, i) => {
            everyPropertyRequired(branch, `${path}.anyOf[${i}]`);
        });
    }
    if (node.items) {
        everyPropertyRequired(node.items, `${path}.items`);
    }
    if (node.properties) {
        const propKeys = Object.keys(node.properties);
        expect(new Set(node.required ?? []), `${path}: required must cover every property`).toEqual(new Set(propKeys));
        for (const key of propKeys) {
            const child = node.properties[key];
            if (child) {
                everyPropertyRequired(child, `${path}.${key}`);
            }
        }
    }
}

describe('CLARIFY_PROPOSAL_SCHEMA', () => {
    it('lists every property as required at every level (structured-output contract)', () => {
        everyPropertyRequired(CLARIFY_PROPOSAL_SCHEMA as unknown as JsonSchemaNode);
    });

    it('exposes exactly the proposable item fields on the patch object', () => {
        const top = CLARIFY_PROPOSAL_SCHEMA as unknown as JsonSchemaNode;
        const patch = top.properties?.proposedItemPatch;
        // proposedItemPatch is nullable → its real shape lives in the non-null anyOf branch.
        const objectBranch = patch?.anyOf?.find((b) => b.type === 'object');
        expect(objectBranch, 'patch should have an object branch').toBeDefined();
        expect(new Set(Object.keys(objectBranch?.properties ?? {}))).toEqual(new Set(PROPOSABLE_ITEM_FIELDS));
    });

    it('keeps enum fields nullable via anyOf, not the type:[T,null] shorthand', () => {
        // The `type: ['string','null']` shorthand is REJECTED by the validator when the node also
        // carries an `enum` (verified live). Pin the anyOf encoding so a "simplifying" refactor that
        // reintroduces the shorthand fails here in CI rather than as a 502 in production.
        const top = CLARIFY_PROPOSAL_SCHEMA as unknown as JsonSchemaNode;
        const patch = top.properties?.proposedItemPatch?.anyOf?.find((b) => b.type === 'object');
        for (const enumField of ['status', 'energy']) {
            const node = patch?.properties?.[enumField];
            const enumBranch = node?.anyOf?.find((b) => Array.isArray((b as { enum?: unknown[] }).enum));
            expect(enumBranch, `${enumField} must keep its enum inside an anyOf branch`).toBeDefined();
            expect(
                node?.anyOf?.some((b) => b.type === 'null'),
                `${enumField} must stay nullable`,
            ).toBe(true);
        }
    });
});
