import { describe, expect, it } from 'vitest';
import { edgeNeighbours, neighboursRelativeTo } from '../components/nextActions/MoveToSheet';

const others = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];

describe('MoveToSheet neighbour resolution', () => {
    it('"Above X" lands between X\'s predecessor and X; "Below X" between X and its successor', () => {
        expect(neighboursRelativeTo(others, 'b', 'above')).toEqual({ aboveId: 'a', belowId: 'b' });
        expect(neighboursRelativeTo(others, 'b', 'below')).toEqual({ aboveId: 'b', belowId: 'c' });
        expect(neighboursRelativeTo(others, 'a', 'above')).toEqual({ aboveId: undefined, belowId: 'a' });
        expect(neighboursRelativeTo(others, 'c', 'below')).toEqual({ aboveId: 'c', belowId: undefined });
    });

    it('top / bottom of section are open-ended on one side', () => {
        expect(edgeNeighbours(others, 'top')).toEqual({ aboveId: undefined, belowId: 'a' });
        expect(edgeNeighbours(others, 'bottom')).toEqual({ aboveId: 'c', belowId: undefined });
        expect(edgeNeighbours([], 'top')).toEqual({ aboveId: undefined, belowId: undefined });
    });
});
