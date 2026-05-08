import type { PersonInterface } from '../../../types/entities.js';

export interface PublicPersonView {
    _id: string;
    name: string;
    email?: string;
    phone?: string;
    externalCalendarId?: string;
    notes?: string;
    createdTs: string;
    updatedTs: string;
}

export function presentPerson(p: PersonInterface): PublicPersonView {
    const view: PublicPersonView = { _id: p._id, name: p.name, createdTs: p.createdTs, updatedTs: p.updatedTs };
    if (p.email !== undefined) view.email = p.email;
    if (p.phone !== undefined) view.phone = p.phone;
    if (p.externalCalendarId !== undefined) view.externalCalendarId = p.externalCalendarId;
    if (p.notes !== undefined) view.notes = p.notes;
    return view;
}
