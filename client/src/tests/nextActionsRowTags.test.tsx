import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedTag } from '../lib/itemSearch';
import { buildRowSecondary, RowTags, readShowTags } from '../routes/_authenticated/next-actions';
import type { StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';

// RowTags returns a single <Box> wrapper; these helpers walk its children without a DOM (vitest runs in node env).
function childrenOf(el: ReactElement): ReactNode[] {
    return Children.toArray((el.props as { children?: ReactNode }).children);
}
function labelOf(el: ReactNode): string | undefined {
    return isValidElement(el) ? (el.props as { label?: string }).label : undefined;
}

describe('RowTags', () => {
    it('renders one chip per work-context and per person, contexts first', () => {
        const el = RowTags({
            contextTags: [
                { id: 'c1', name: '@phone' },
                { id: 'c2', name: '@errands' },
            ],
            personTags: [{ id: 'p1', name: 'Dana' }],
            dueLabel: null,
        });
        if (!el) throw new Error('expected RowTags to render');
        const labels = childrenOf(el)
            .map(labelOf)
            .filter((l): l is string => l !== undefined);
        expect(labels).toEqual(['@phone', '@errands', 'Dana']);
    });

    it('gives each chip a unique key even when display names repeat', () => {
        // Two distinct people both named "Dana" must not collide — keys come from entity id, not name.
        const el = RowTags({
            contextTags: [],
            personTags: [
                { id: 'p1', name: 'Dana' },
                { id: 'p2', name: 'Dana' },
            ],
            dueLabel: null,
        });
        if (!el) throw new Error('expected RowTags to render');
        const keys = childrenOf(el).map((c) => (isValidElement(c) ? c.key : null));
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('appends the due label as a trailing element when present', () => {
        const el = RowTags({ contextTags: [{ id: 'c1', name: '@phone' }], personTags: [], dueLabel: 'Due Jun 6' });
        if (!el) throw new Error('expected RowTags to render');
        const kids = childrenOf(el);
        const [lastChild] = kids.slice(-1);
        // The due label is plain text inside a Typography, not a chip (no `label` prop).
        expect(labelOf(lastChild)).toBeUndefined();
        expect(isValidElement(lastChild) && (lastChild.props as { children?: ReactNode }).children).toBe('Due Jun 6');
    });

    it('renders nothing when there are no tags and no due label', () => {
        expect(RowTags({ contextTags: [], personTags: [], dueLabel: null })).toBeNull();
    });

    it('still renders when only a due label is present (no tags)', () => {
        const el = RowTags({ contextTags: [], personTags: [], dueLabel: 'Due Jun 6' });
        if (!el) throw new Error('expected RowTags to render the due label alone');
        expect(childrenOf(el)).toHaveLength(1);
    });
});

describe('buildRowSecondary', () => {
    const context = (id: string, name: string): StoredWorkContext => ({ _id: id, name, userId: 'u', createdTs: '', updatedTs: '' });
    const person = (id: string, name: string): StoredPerson => ({ _id: id, name, userId: 'u', createdTs: '', updatedTs: '' });
    const item = (over: Partial<StoredItem>): StoredItem =>
        ({ _id: 'i1', userId: 'u', status: 'nextAction', title: 'T', createdTs: '', updatedTs: '', ...over }) as StoredItem;

    const contextsById = new Map([['c1', context('c1', '@phone')]]);
    const peopleById = new Map([['p1', person('p1', 'Dana')]]);

    it('returns the "Due" string (not chips) when tags are hidden', () => {
        const result = buildRowSecondary(item({ expectedBy: '2026-06-06', workContextIds: ['c1'] }), { showTags: false, contextsById, peopleById });
        expect(result).toBe('Due Jun 6');
    });

    it('returns undefined when tags hidden and there is no due date', () => {
        const result = buildRowSecondary(item({ workContextIds: ['c1'] }), { showTags: false, contextsById, peopleById });
        expect(result).toBeUndefined();
    });

    it('returns a RowTags element when tags are shown', () => {
        const result = buildRowSecondary(item({ workContextIds: ['c1'], peopleIds: ['p1'] }), { showTags: true, contextsById, peopleById });
        expect(isValidElement(result)).toBe(true);
    });

    it('drops ids that no longer resolve to a context or person', () => {
        // buildRowSecondary returns an unrendered <RowTags> element; assert via the props it was handed.
        const result = buildRowSecondary(item({ workContextIds: ['c1', 'gone'], peopleIds: ['p1', 'gone'] }), { showTags: true, contextsById, peopleById });
        if (!isValidElement(result)) throw new Error('expected a RowTags element');
        const props = result.props as { contextTags: ResolvedTag[]; personTags: ResolvedTag[] };
        expect(props.contextTags.map((t) => t.name)).toEqual(['@phone']);
        expect(props.personTags.map((t) => t.name)).toEqual(['Dana']);
    });
});

describe('readShowTags', () => {
    const store = new Map<string, string>();
    // Minimal localStorage shim — vitest's node env has no DOM/localStorage.
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        },
    });

    afterEach(() => store.clear());

    it('defaults to true when nothing is stored', () => {
        expect(readShowTags()).toBe(true);
    });

    it('returns false only when explicitly stored as "false"', () => {
        localStorage.setItem('nextActions.showTags', 'false');
        expect(readShowTags()).toBe(false);
    });

    it('treats any non-"false" value as on', () => {
        // A non-'true' value exercises the `!== 'false'` contract (a buggy `=== 'true'` would fail here).
        localStorage.setItem('nextActions.showTags', '1');
        expect(readShowTags()).toBe(true);
    });
});
