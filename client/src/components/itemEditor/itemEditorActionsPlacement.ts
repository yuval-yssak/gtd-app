/**
 * Tri-state `actionsContainer` semantics for ItemEditorBody:
 * - `undefined` (prop absent) — the actions row renders inline at the end of the body.
 * - an element — the row portals into it (hosts with a pinned action bar, e.g. the weekly review).
 * - `null` — the host WILL provide a container but its ref hasn't mounted yet; rendering inline
 *   for that first frame would flash the buttons at the wrong spot, so nothing renders until the
 *   element arrives.
 *
 * Returns a discriminated union so the portal arm carries the (narrowed, non-null) container —
 * the call site needs no re-check.
 */
export function resolveActionsPlacement(actionsContainer: HTMLElement | null | undefined) {
    if (actionsContainer === undefined) {
        return { kind: 'inline' } as const;
    }
    return actionsContainer === null ? ({ kind: 'deferred' } as const) : ({ kind: 'portal', container: actionsContainer } as const);
}
