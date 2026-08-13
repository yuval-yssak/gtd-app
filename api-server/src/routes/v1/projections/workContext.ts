import type { WorkContextInterface } from '../../../types/entities.js';

export interface PublicWorkContextView {
    _id: string;
    name: string;
    archived?: boolean;
    createdTs: string;
    updatedTs: string;
}

export function presentWorkContext(wc: WorkContextInterface): PublicWorkContextView {
    return {
        _id: wc._id,
        name: wc.name,
        ...(wc.archived !== undefined ? { archived: wc.archived } : {}),
        createdTs: wc.createdTs,
        updatedTs: wc.updatedTs,
    };
}
