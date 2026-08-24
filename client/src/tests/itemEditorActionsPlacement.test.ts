import { describe, expect, it } from 'vitest';
import { resolveActionsPlacement } from '../components/itemEditor/itemEditorActionsPlacement';

describe('resolveActionsPlacement', () => {
    it('renders inline when the host declares no container (prop absent)', () => {
        expect(resolveActionsPlacement(undefined)).toEqual({ kind: 'inline' });
    });

    it('defers (renders nothing) while the declared container ref has not mounted yet', () => {
        // NOT inline: falling back to inline for that first frame would flash the buttons inside
        // the scrolling card before they jump into the pinned bar.
        expect(resolveActionsPlacement(null)).toEqual({ kind: 'deferred' });
    });

    it('portals once the container element exists, carrying it narrowed for the call site', () => {
        // Node test env has no DOM; the helper only null-checks, so a plain object stands in.
        const container = {} as HTMLElement;
        expect(resolveActionsPlacement(container)).toEqual({ kind: 'portal', container });
    });
});
