import { describe, expect, it } from 'vitest';
import { mergeCleanStringFields, stringFieldsEqual } from '../lib/liveMerge';

const seed = { name: 'Dana', email: 'dana@example.com', phone: '' };

describe('liveMerge', () => {
    it('adopts incoming values into clean fields only', () => {
        const form = { ...seed, name: 'Dana Lee' }; // name dirty, others clean
        const incoming = { name: 'Dana R.', email: 'dana@new.example.com', phone: '555' };

        const merged = mergeCleanStringFields(form, seed, incoming);

        expect(merged.name).toBe('Dana Lee'); // dirty — local wins
        expect(merged.email).toBe('dana@new.example.com'); // clean — remote adopted
        expect(merged.phone).toBe('555');
    });

    it('is an identity when the form is fully clean', () => {
        const incoming = { name: 'Renamed', email: '', phone: '1' };
        expect(mergeCleanStringFields(seed, seed, incoming)).toEqual(incoming);
    });

    it('stringFieldsEqual compares by every key', () => {
        expect(stringFieldsEqual(seed, { ...seed })).toBe(true);
        expect(stringFieldsEqual(seed, { ...seed, phone: 'x' })).toBe(false);
    });
});
