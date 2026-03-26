export const ItemStatus = {
    inbox: 'inbox',
    nextAction: 'nextAction',
    calendar: 'calendar',
    waitingFor: 'waitingFor',
    done: 'done',
    trash: 'trash',
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

export interface ItemInterface {
    /**
     * Client-generated UUID used as the MongoDB _id. Optional so MongoDB accepts documents created without one (e.g. in tests) but always present in practice.
     */
    _id?: string;
    user: string; // Better Auth user ID (UUID string, not ObjectId)
    status: ItemStatus;
    title: string;
    createdTs: string;
    /**
     * relevant only for `nextAction` type items
     */
    workContexts?: string[];
    people?: string[];
    /**
     * relevant only for `nextAction` or `waitingFor` type items
     *
     * One-day resolution
     */
    expectedBy?: string;
    /**
     * relevant only for `calendar` type items
     */
    timeStart?: string;
    /**
     * relevant only for `calendar` type items
     */
    timeEnd?: string;
    /**
     * relevant only for `nextAction` type items
     */
    energy?: 'low' | 'medium' | 'high';
    /**
     * relevant only for `nextAction` type items
     *
     * In minutes
     */
    time?: number;
    /**
     * relevant only for `nextAction` type items
     */
    focus?: boolean;
    /**
     * relevant only for `nextAction` type items
     */
    urgent?: boolean;
}
