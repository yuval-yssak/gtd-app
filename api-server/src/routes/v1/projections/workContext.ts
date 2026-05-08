import type { WorkContextInterface } from '../../../types/entities.js';

export interface PublicWorkContextView {
    _id: string;
    name: string;
    createdTs: string;
    updatedTs: string;
}

export function presentWorkContext(wc: WorkContextInterface): PublicWorkContextView {
    return { _id: wc._id, name: wc.name, createdTs: wc.createdTs, updatedTs: wc.updatedTs };
}
