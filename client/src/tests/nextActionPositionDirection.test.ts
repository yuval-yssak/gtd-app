import { describe, expect, it } from 'vitest';
import { moveDirectionOf } from '../lib/nextActionPosition';

const SECTION = ['a', 'b', 'c', 'd'];

describe('moveDirectionOf', () => {
    it('Top and Up land above the item', () => {
        expect(moveDirectionOf(SECTION, 'c', { aboveId: undefined, belowId: 'a' })).toBe('up');
        expect(moveDirectionOf(SECTION, 'c', { aboveId: 'a', belowId: 'b' })).toBe('up');
    });

    it('Down and Bottom land below the item', () => {
        expect(moveDirectionOf(SECTION, 'b', { aboveId: 'c', belowId: 'd' })).toBe('down');
        expect(moveDirectionOf(SECTION, 'b', { aboveId: 'd', belowId: undefined })).toBe('down');
    });

    it('a Move to… pick resolves by where the row it lands under sits', () => {
        expect(moveDirectionOf(SECTION, 'd', { aboveId: 'a', belowId: 'b' })).toBe('up');
        expect(moveDirectionOf(SECTION, 'a', { aboveId: 'b', belowId: 'c' })).toBe('down');
    });
});
