import type { StoredItem } from '../types/MyDB';

/**
 * Labels of the clarify-phase fields still missing on a nextAction item, in display order.
 * Empty array = fully clarified. The work-context criterion only applies when the user has at
 * least one work context defined — otherwise every item would warn for a taxonomy they don't use.
 */
export function missingClarifications(item: StoredItem, hasWorkContexts: boolean): string[] {
    const criteria: Array<{ label: string; isMissing: boolean }> = [
        { label: 'energy', isMissing: item.energy === undefined },
        { label: 'time estimate', isMissing: item.time === undefined },
        { label: 'work context', isMissing: hasWorkContexts && (item.workContextIds ?? []).length === 0 },
    ];
    return criteria.filter((criterion) => criterion.isMissing).map((criterion) => criterion.label);
}
