import { describe, expect, it } from 'vitest';
import { stableStringify } from '../lib/stableStringify.js';

describe('stableStringify', () => {
    it('produces equal strings for nested objects with reordered keys', () => {
        const a = { outer: { b: 1, a: 2 }, z: 3, m: 4 };
        const b = { m: 4, z: 3, outer: { a: 2, b: 1 } };
        expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it('preserves array order — peopleIds:[a,b] differs from [b,a]', () => {
        // Arrays are order-significant (peopleIds, workContextIds): reordering must NOT compare equal.
        const ab = { peopleIds: ['a', 'b'] };
        const ba = { peopleIds: ['b', 'a'] };
        expect(stableStringify(ab)).not.toBe(stableStringify(ba));
        // Same-order arrays still compare equal.
        expect(stableStringify(ab)).toBe(stableStringify({ peopleIds: ['a', 'b'] }));
    });

    it('distinguishes a null value from a missing key', () => {
        // JSON.stringify keeps null values but drops them entirely when absent, so the two serialize
        // differently — a null field is a real, present value.
        expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
        expect(stableStringify({ a: null })).toBe('{"a":null}');
        expect(stableStringify({})).toBe('{}');
    });

    it('drops undefined object values (JSON.stringify semantics) so {a:undefined} === {}', () => {
        // Documented behavior: JSON.stringify omits object properties whose value is undefined, so an
        // explicit `{a: undefined}` serializes identically to `{}`. Callers must not rely on undefined
        // fields to distinguish snapshots.
        expect(stableStringify({ a: undefined })).toBe('{}');
        expect(stableStringify({ a: undefined })).toBe(stableStringify({}));
    });

    it('serializes primitives and null at the top level', () => {
        expect(stableStringify(null)).toBe('null');
        expect(stableStringify(42)).toBe('42');
        expect(stableStringify('x')).toBe('"x"');
    });
});
