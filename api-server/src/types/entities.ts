import type { ObjectId } from 'mongodb';

type ThirdPartyToken = {
    provider: string;
    accessToken: string;
    refreshToken: string;
    expireTs: string;
};

export interface UserInterface {
    firstName: string;
    lastName: string;
    email: string;
    picture: string;
    createdTs: string;
    updatedTs: string;
    tokens: ThirdPartyToken[];
}

export interface ItemInterface {
    user: ObjectId;
    status: 'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'done' | 'trash';
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
