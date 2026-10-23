import type { EntitySnapshot } from '../types/entities.js';

/**
 * `focus` (the "In focus" shortlist flag on items and routine templates) was replaced by the
 * `rank` priority order. The op schemas still ACCEPT it — old clients keep sending it, and a
 * `.strict()` schema narrower than a deployed client's snapshot would 400 the whole /sync/push
 * batch and jam its queue — but nothing may persist it: `stampSnapshot` (`applyOperation.ts`),
 * which every write path funnels through, strips it here so neither the row nor the op log
 * carries the flag. The public API and MCP therefore accept-and-drop it (PUBLIC_API.md § Changelog).
 */
export function stripDeprecatedFocus(snapshot: EntitySnapshot): EntitySnapshot {
    const { focus: _focus, ...rest } = snapshot as EntitySnapshot & { focus?: unknown };
    if (!('template' in rest) || !isRecord(rest.template)) {
        return rest as EntitySnapshot;
    }
    const { focus: _templateFocus, ...template } = rest.template;
    return { ...rest, template } as EntitySnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
