import { describe, expect, it } from 'vitest';
import { entityDisplayName } from '../lib/entityDisplayName.js';
import type { ClaudeAskInterface, ItemBriefInterface, ItemInterface, PersonInterface } from '../types/entities.js';

const TS = '2026-01-01T00:00:00.000Z';

describe('entityDisplayName', () => {
    it('prefers title, then name, then brief text', () => {
        const item: ItemInterface = { _id: 'i', user: 'u', status: 'inbox', title: 'Call dentist', createdTs: TS, updatedTs: TS };
        const person: PersonInterface = { _id: 'p', user: 'u', name: 'Jane', createdTs: TS, updatedTs: TS };
        const brief: ItemBriefInterface = {
            _id: 'i',
            user: 'u',
            itemId: 'i',
            text: 'Still waiting on X',
            origin: 'agent',
            sourceHash: 'h',
            generatedTs: TS,
            createdTs: TS,
            updatedTs: TS,
        };
        expect(entityDisplayName(item)).toBe('Call dentist');
        expect(entityDisplayName(person)).toBe('Jane');
        expect(entityDisplayName(brief)).toBe('Still waiting on X');
    });

    it('labels a Claude ask by its prompt', () => {
        const ask: ClaudeAskInterface = {
            _id: 'a',
            user: 'u',
            itemId: 'i',
            prompt: 'Rename it',
            sessionId: 's',
            sessionUrl: 'https://claude.ai/code/s',
            createdTs: TS,
            updatedTs: TS,
        };
        expect(entityDisplayName(ask)).toBe('Rename it');
    });

    it('returns no label (undefined, not an empty string) for a skipped brief', () => {
        const skipped: ItemBriefInterface = {
            _id: 'i',
            user: 'u',
            itemId: 'i',
            text: null,
            origin: 'skipped',
            sourceHash: 'h',
            generatedTs: TS,
            createdTs: TS,
            updatedTs: TS,
        };
        expect(entityDisplayName(skipped)).toBeUndefined();
    });
});
