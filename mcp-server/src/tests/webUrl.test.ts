import { describe, expect, it } from 'vitest';
import { resolveWebBase } from '../config.js';
import { decorateWithUrls } from '../tools/webUrl.js';

const STAGING = 'https://staging.getting-things-done.app';

describe('resolveWebBase', () => {
    it('maps each known environment to its web origin', () => {
        expect(resolveWebBase('local')).toBe('http://localhost:4173');
        expect(resolveWebBase('staging')).toBe(STAGING);
        expect(resolveWebBase('production')).toBe('https://getting-things-done.app');
    });

    it('returns null for custom hosts (web origin not derivable)', () => {
        expect(resolveWebBase('custom')).toBeNull();
    });

    it('honours a GTD_WEB_BASE override for any environment, trimming trailing slashes', () => {
        expect(resolveWebBase('custom', 'https://gtd.internal.example/')).toBe('https://gtd.internal.example');
        expect(resolveWebBase('production', 'https://preview.example')).toBe('https://preview.example');
    });
});

describe('decorateWithUrls', () => {
    it('stamps an item deep link on a single-item response', () => {
        const result = decorateWithUrls('gtd_capture', { _id: 'abc123', title: 'buy milk' }, STAGING);
        expect(result).toEqual({ _id: 'abc123', title: 'buy milk', url: `${STAGING}/item/abc123` });
    });

    it('stamps a routine deep link on a single-routine response', () => {
        const result = decorateWithUrls('gtd_create_routine', { _id: 'r1', name: 'water plants' }, STAGING);
        expect(result).toEqual({ _id: 'r1', name: 'water plants', url: `${STAGING}/routine/r1` });
    });

    it('stamps a url onto every entity in a list envelope, preserving other keys', () => {
        const result = decorateWithUrls('gtd_list_items', { items: [{ _id: 'a' }, { _id: 'b' }], nextCursor: 'c' }, STAGING);
        expect(result).toEqual({
            items: [
                { _id: 'a', url: `${STAGING}/item/a` },
                { _id: 'b', url: `${STAGING}/item/b` },
            ],
            nextCursor: 'c',
        });
    });

    it('uses the routines key for routine list responses', () => {
        const result = decorateWithUrls('gtd_list_routines', { routines: [{ _id: 'r1' }] }, STAGING);
        expect(result).toEqual({ routines: [{ _id: 'r1', url: `${STAGING}/routine/r1` }] });
    });

    it('stamps a url on both head and tail of a split-routine { head, tail } response', () => {
        const result = decorateWithUrls('gtd_split_routine', { head: { _id: 'h1' }, tail: { _id: 't1' } }, STAGING);
        expect(result).toEqual({
            head: { _id: 'h1', url: `${STAGING}/routine/h1` },
            tail: { _id: 't1', url: `${STAGING}/routine/t1` },
        });
    });

    it('stamps only the present leg of a partial split payload, never injecting an undefined sibling', () => {
        const result = decorateWithUrls('gtd_split_routine', { head: { _id: 'h1' } }, STAGING);
        expect(result).toEqual({ head: { _id: 'h1', url: `${STAGING}/routine/h1` } });
        expect(Object.hasOwn(result as object, 'tail')).toBe(false);
    });

    it('passes a non-record split payload through unchanged', () => {
        expect(decorateWithUrls('gtd_split_routine', null, STAGING)).toBeNull();
    });

    it('passes an empty list envelope through unchanged', () => {
        expect(decorateWithUrls('gtd_list_items', { items: [] }, STAGING)).toEqual({ items: [] });
    });

    it('leaves a list element without an _id untouched while still stamping its siblings', () => {
        const result = decorateWithUrls('gtd_list_items', { items: [{ _id: 'a' }, { title: 'no id' }] }, STAGING);
        expect(result).toEqual({ items: [{ _id: 'a', url: `${STAGING}/item/a` }, { title: 'no id' }] });
    });

    it('stamps a person deep link on single-person responses', () => {
        const created = decorateWithUrls('gtd_create_person', { _id: 'p1', name: 'Alex' }, STAGING);
        expect(created).toEqual({ _id: 'p1', name: 'Alex', url: `${STAGING}/person/p1` });
        const updated = decorateWithUrls('gtd_update_person', { _id: 'p2', name: 'Sam' }, STAGING);
        expect(updated).toEqual({ _id: 'p2', name: 'Sam', url: `${STAGING}/person/p2` });
    });

    it('uses the people key for person list responses', () => {
        const result = decorateWithUrls('gtd_list_people', { people: [{ _id: 'p1' }] }, STAGING);
        expect(result).toEqual({ people: [{ _id: 'p1', url: `${STAGING}/person/p1` }] });
    });

    it('leaves unknown tools (work contexts, person delete, batch) untouched', () => {
        const workContextResult = decorateWithUrls('gtd_create_work_context', { _id: 'w1', name: 'near a phone' }, STAGING);
        expect(workContextResult).toEqual({ _id: 'w1', name: 'near a phone' });
        const deleteResult = decorateWithUrls('gtd_delete_person', { ok: true }, STAGING);
        expect(deleteResult).toEqual({ ok: true });
        const batchResult = decorateWithUrls('gtd_batch', { ok: true, count: 3 }, STAGING);
        expect(batchResult).toEqual({ ok: true, count: 3 });
    });

    it('is a no-op when the web base is null (custom env with no override)', () => {
        const result = decorateWithUrls('gtd_capture', { _id: 'abc123' }, null);
        expect(result).toEqual({ _id: 'abc123' });
    });

    it('passes payloads through unchanged when the shape does not match (envelope drift)', () => {
        // A single-item tool that somehow returned an error-ish object without an _id.
        const noId = decorateWithUrls('gtd_get_item', { error: 'not found' }, STAGING);
        expect(noId).toEqual({ error: 'not found' });
        // A list tool whose list key isn't an array.
        const badList = decorateWithUrls('gtd_list_items', { items: null }, STAGING);
        expect(badList).toEqual({ items: null });
    });
});
