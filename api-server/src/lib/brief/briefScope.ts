import type { ItemStatus } from '../../types/entities.js';

/**
 * WHICH items get a brief at all. Its own module — not `lib/briefSource.ts`, whose contents are
 * logic-mirrored on the client under a parity test, and not `briefTargets.ts`, which imports from
 * `briefService.ts` and would form a cycle.
 *
 * A brief is a Weekly-Review affordance: it condenses an item's notes so the reviewer can triage
 * it at a glance. A `done` or `trash` item is never reviewed, so a brief for one is spend that can
 * never be read.
 *
 * This REVERSES the original Phase-2 decision to target every status
 * (docs/plans/item-brief.md § "Targeting scope"). That decision is what made the sweep expensive:
 * of the 11 926 items in the staging corpus, 10 722 are closed — 90 % of everything the sweep
 * walked — and 2 711 briefs had already been generated for items nobody would ever review.
 *
 * Briefs already written for closed items are KEPT. They are paid for, they harm nothing, and an
 * item revived from trash or reopened from done arrives with its brief either still fresh or
 * correctly reading stale. There is deliberately no cleanup pass that deletes them.
 */
export const LIVE_STATUSES: ItemStatus[] = ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe'];

/** False for `done` / `trash` — the statuses a brief is never generated for. */
export function isBriefableStatus(status: ItemStatus): boolean {
    return LIVE_STATUSES.includes(status);
}
