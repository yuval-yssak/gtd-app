/**
 * Render-free coverage for the SyncIssuesPanel row presentation (`syncIssueRowLogic.ts`) — same
 * pattern as `calendarRowMeta.test.ts`. No jsdom: the helper is pure, so every display edge case
 * (missing title, whitespace title, retryable detail gate, timestamp fallbacks) is a plain assert.
 */
import { describe, expect, it } from 'vitest';
import type { SyncIssue } from '../api/syncApi';
import { syncIssueRowText } from '../components/syncIssueRowLogic';
import type { EntityType } from '../types/MyDB';

function makeIssue(overrides: Partial<SyncIssue> = {}): SyncIssue {
    return {
        _id: 'op-1',
        ts: '2026-08-15T14:48:20.621Z',
        opType: 'update',
        entityType: 'item',
        entityId: 'item-1',
        failureReason: 'entity_missing',
        retryable: false,
        ...overrides,
    };
}

describe('syncIssueRowText — title', () => {
    it('quotes the entity title when present', () => {
        expect(syncIssueRowText(makeIssue({ entityTitle: 'Best Invest breakdown' })).title).toBe('“Best Invest breakdown”');
    });

    it('falls back to the entity-type label when the server could not resolve a title', () => {
        expect(syncIssueRowText(makeIssue({ entityType: 'item' })).title).toBe('Item');
        expect(syncIssueRowText(makeIssue({ entityType: 'workContext' })).title).toBe('Work context');
    });

    it('treats a whitespace-only title as missing', () => {
        expect(syncIssueRowText(makeIssue({ entityTitle: '   ' })).title).toBe('Item');
    });

    it('renders an unknown (forward-compat) entity type as its raw value', () => {
        // Cast is deliberate: simulates a server that added an entity type this build predates.
        const futureType = 'gizmo' as EntityType;
        expect(syncIssueRowText(makeIssue({ entityType: futureType })).title).toBe('gizmo');
    });
});

describe('syncIssueRowText — reason', () => {
    it('combines the op verb with the failure label', () => {
        const { reason } = syncIssueRowText(makeIssue({ opType: 'rsvp', failureReason: 'scope_missing' }));
        expect(reason).toBe('RSVP failed — Google needs additional permissions to complete this change.');
    });
});

describe('syncIssueRowText — meta timestamp', () => {
    it('prefers failedTs over ts (ts mutates on retry)', () => {
        const { meta } = syncIssueRowText(makeIssue({ ts: '2026-08-15T20:00:00.000Z', failedTs: '2026-08-14T10:30:00.000Z' }));
        expect(meta).toContain('Aug 14');
        expect(meta).not.toContain('Aug 15');
    });

    it('falls back to ts on legacy rows without failedTs', () => {
        expect(syncIssueRowText(makeIssue()).meta).toContain('Aug 15');
    });

    it("degrades to 'unknown time' on an unparseable timestamp instead of rendering Invalid Date", () => {
        expect(syncIssueRowText(makeIssue({ ts: 'garbage' })).meta).toBe('Item · unknown time');
    });
});

describe('syncIssueRowText — detail gate', () => {
    const detail = 'Google Calendar API: insufficient scope';

    it('shows the raw server detail only for retryable failures', () => {
        expect(syncIssueRowText(makeIssue({ retryable: true, failureDetail: detail })).showDetail).toBe(true);
        expect(syncIssueRowText(makeIssue({ retryable: false, failureDetail: detail })).showDetail).toBe(false);
        expect(syncIssueRowText(makeIssue({ retryable: true })).showDetail).toBe(false); // no detail to show
    });
});
