import { describe, expect, it } from 'vitest';
import { orderPeople, personMatchesQuery } from '../lib/peopleList';
import type { StoredPerson } from '../types/MyDB';

function makePerson(overrides: Partial<StoredPerson> & { name: string }): StoredPerson {
    return {
        _id: `id-${overrides.name}`,
        userId: 'user-1',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('orderPeople', () => {
    it('sorts alphabetically by name, case-insensitively', () => {
        const people = [makePerson({ name: 'charlie' }), makePerson({ name: 'Alice' }), makePerson({ name: 'bob' })];
        expect(orderPeople(people, '').map((p) => p.name)).toEqual(['Alice', 'bob', 'charlie']);
    });

    it('parks archived people at the bottom, each partition alphabetical', () => {
        const people = [
            makePerson({ name: 'Zoe', archived: true }),
            makePerson({ name: 'Yann' }),
            makePerson({ name: 'Abe', archived: true }),
            makePerson({ name: 'Ben' }),
        ];
        expect(orderPeople(people, '').map((p) => p.name)).toEqual(['Ben', 'Yann', 'Abe', 'Zoe']);
    });

    it('filters by the query before ordering, trimming and ignoring case', () => {
        const people = [makePerson({ name: 'Carmel Blanca' }), makePerson({ name: 'Dana' })];
        expect(orderPeople(people, '  CARMEL ').map((p) => p.name)).toEqual(['Carmel Blanca']);
    });

    it('returns archived matches even when no active person matches', () => {
        const people = [makePerson({ name: 'Zed', archived: true }), makePerson({ name: 'Ann' })];
        expect(orderPeople(people, 'zed').map((p) => p.name)).toEqual(['Zed']);
    });

    it('returns an empty list for an empty input and for a query matching no one', () => {
        expect(orderPeople([], 'anything')).toEqual([]);
        expect(orderPeople([makePerson({ name: 'Ann' })], 'no-match')).toEqual([]);
    });
});

describe('personMatchesQuery', () => {
    const person = makePerson({
        name: 'Carmel Blanca',
        email: 'carmel.blanca@winn.ai',
        phone: '+972-50-1234567',
        notes: 'Slack: @carmel — timezone Asia/Jerusalem',
    });

    it('matches on every searchable field', () => {
        expect(personMatchesQuery(person, 'blanca')).toBe(true);
        expect(personMatchesQuery(person, 'winn.ai')).toBe(true);
        expect(personMatchesQuery(person, '1234567')).toBe(true);
        expect(personMatchesQuery(person, 'jerusalem')).toBe(true);
    });

    it('normalizes the query itself — an upper-case query still matches', () => {
        expect(personMatchesQuery(person, 'BLANCA')).toBe(true);
    });

    it('folds diacritics on both sides — "jose" finds "José" and vice versa', () => {
        const jose = makePerson({ name: 'José' });
        expect(personMatchesQuery(jose, 'jose')).toBe(true);
        expect(personMatchesQuery(makePerson({ name: 'Jose' }), 'josé')).toBe(true);
    });

    it('returns false when no field contains the query', () => {
        expect(personMatchesQuery(person, 'nomatch')).toBe(false);
    });

    it('matches everyone on an empty query, including people with only a name', () => {
        expect(personMatchesQuery(person, '')).toBe(true);
        expect(personMatchesQuery(makePerson({ name: 'Solo' }), '')).toBe(true);
        expect(personMatchesQuery(makePerson({ name: 'Solo' }), 'solo')).toBe(true);
    });
});
