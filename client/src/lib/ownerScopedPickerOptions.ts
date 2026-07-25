/** The owner account plus the references the entity already carries — everything needed to scope
 *  a picker's option list without dangling pre-existing cross-account assignments. */
interface OwnerScope<T> {
    ownerUserId: string;
    assignedIds: string[];
    /** Unfiltered superset (AppData `all*`) used to resolve assigned cross-account references. */
    allOptions: T[];
}

/**
 * Scopes an editor picker's option list to the entity's owning account. In the merged
 * multi-account view every account owns its own default contexts (e.g. "anywhere"), so an
 * unscoped picker renders indistinguishable duplicate chips and lets an item be tagged with
 * another account's entity. Ids already assigned to the entity are appended back from the
 * unfiltered set so a pre-existing cross-account tag still renders a readable, removable chip
 * instead of silently vanishing.
 */
export function scopeOptionsToOwner<T extends { _id: string; userId: string }>(options: T[], scope: OwnerScope<T>): T[] {
    const owned = options.filter((option) => option.userId === scope.ownerUserId);
    const ownedIds = new Set(owned.map((option) => option._id));
    const strayIds = [...new Set(scope.assignedIds)].filter((id) => !ownedIds.has(id));
    const strays = strayIds.flatMap((id) => scope.allOptions.find((option) => option._id === id) ?? []);
    return [...owned, ...strays];
}
