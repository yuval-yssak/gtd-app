import type { PersonInterface } from '../../../types/entities.js';

export interface PublicPersonView {
    _id: string;
    name: string;
    email?: string;
    phone?: string;
    externalCalendarId?: string;
    notes?: string;
    archived?: boolean;
    createdTs: string;
    updatedTs: string;
}

export function presentPerson(p: PersonInterface): PublicPersonView {
    return {
        _id: p._id,
        name: p.name,
        ...(p.email !== undefined ? { email: p.email } : {}),
        ...(p.phone !== undefined ? { phone: p.phone } : {}),
        ...(p.externalCalendarId !== undefined ? { externalCalendarId: p.externalCalendarId } : {}),
        ...(p.notes !== undefined ? { notes: p.notes } : {}),
        ...(p.archived !== undefined ? { archived: p.archived } : {}),
        createdTs: p.createdTs,
        updatedTs: p.updatedTs,
    };
}
