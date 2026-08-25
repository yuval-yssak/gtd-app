import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteWeeklyReviewDraft, getWeeklyReviewDraft, saveWeeklyReviewDraft, weeklyReviewDraftKey } from '../components/weeklyReview/reviewDraftHelpers';
import { REVIEW_STAGES, stageIndexOf, startReviewFlow, withStageQueue } from '../components/weeklyReview/reviewFlowState';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

describe('weekly review draft persistence', () => {
    it('round-trips a flow through save → get, undo snapshots included', async () => {
        let flow = startReviewFlow('2026-08-23T09:00:00.000Z');
        const undoSnapshot = {
            _id: 'x',
            userId: USER_ID,
            title: 'was a next action',
            status: 'nextAction',
            createdTs: '2026-08-01T00:00:00.000Z',
            updatedTs: '2026-08-20T00:00:00.000Z',
        } as const;
        const savedQueue = {
            pending: ['a', 'b'],
            cursor: 1,
            // All three undo shapes: snapshot restore, requeue-only, and not-undoable.
            decisions: [{ itemId: 'x', undo: { snapshot: undoSnapshot } }, { itemId: 'y', undo: {} }, { itemId: 'z' }],
        };
        flow = withStageQueue({ ...flow, stageIndex: 2, tickedInboxIds: ['system', 'ri-1'] }, 'clarify', savedQueue);

        await saveWeeklyReviewDraft(db, USER_ID, flow);
        const restored = await getWeeklyReviewDraft(db, USER_ID);

        // Everything round-trips EXCEPT the cursor: resume restarts the walk at the first
        // undecided item (a stored mid-walk position is deliberately discarded on read).
        expect(restored).toEqual({ ...flow, queues: { clarify: { ...savedQueue, cursor: 0 } } });
    });

    it('delete removes the draft', async () => {
        await saveWeeklyReviewDraft(db, USER_ID, startReviewFlow('2026-08-23T09:00:00.000Z'));
        await deleteWeeklyReviewDraft(db, USER_ID);
        expect(await getWeeklyReviewDraft(db, USER_ID)).toBeUndefined();
    });

    it('drops queues and skips for stage ids this build does not know', async () => {
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'weeklyReview',
            userId: USER_ID,
            updatedTs: '2026-08-23T09:00:00.000Z',
            flow: {
                stageIndex: 1,
                tickedInboxIds: [],
                queues: { retiredStage: { pending: ['x'], decisions: [] }, clarify: { pending: ['a'], decisions: [{ itemId: 'b' }] } },
                skippedStageIds: ['retiredStage', 'calendar'],
                startedTs: '2026-08-23T09:00:00.000Z',
            },
        });

        const flow = await getWeeklyReviewDraft(db, USER_ID);

        expect(Object.keys(flow?.queues ?? {})).toEqual(['clarify']);
        expect(flow?.skippedStageIds).toEqual(['calendar']);
    });

    it('coerces legacy drafts: processedIds become snapshot-less decisions; a bare pending list gets an empty history', async () => {
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'weeklyReview',
            userId: USER_ID,
            updatedTs: '2026-08-23T09:00:00.000Z',
            flow: {
                stageIndex: 1,
                tickedInboxIds: [],
                queues: { clarify: { pending: ['a'], processedIds: ['b'] }, nextActions: { pending: ['c'] } },
                skippedStageIds: [],
                startedTs: '2026-08-23T09:00:00.000Z',
            },
        });

        const flow = await getWeeklyReviewDraft(db, USER_ID);

        // Pre-cursor drafts (which rotated the pending list instead) resume at cursor 0.
        expect(flow?.queues.clarify).toEqual({ pending: ['a'], cursor: 0, decisions: [{ itemId: 'b' }] });
        expect(flow?.queues.nextActions).toEqual({ pending: ['c'], cursor: 0, decisions: [] });
    });

    it('ignores any stored cursor — resume restarts the walk even for a nonsense value', async () => {
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'weeklyReview',
            userId: USER_ID,
            updatedTs: '2026-08-23T09:00:00.000Z',
            flow: {
                stageIndex: 1,
                tickedInboxIds: [],
                queues: { clarify: { pending: ['a'], cursor: 99, decisions: [] } },
                skippedStageIds: [],
                startedTs: '2026-08-23T09:00:00.000Z',
            },
        });

        const flow = await getWeeklyReviewDraft(db, USER_ID);

        expect(flow?.queues.clarify?.cursor).toBe(0);
    });

    it('coerces the transitional flat-undoSnapshot decision shape into a nested undo payload', async () => {
        const undoSnapshot = {
            _id: 'x',
            userId: USER_ID,
            title: 'was a next action',
            status: 'nextAction',
            createdTs: '2026-08-01T00:00:00.000Z',
            updatedTs: '2026-08-20T00:00:00.000Z',
        } as const;
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'weeklyReview',
            userId: USER_ID,
            updatedTs: '2026-08-23T09:00:00.000Z',
            flow: {
                stageIndex: 1,
                tickedInboxIds: [],
                queues: { nextActions: { pending: [], decisions: [{ itemId: 'x', undoSnapshot }, { itemId: 'y' }] } },
                skippedStageIds: [],
                startedTs: '2026-08-23T09:00:00.000Z',
            },
        });

        const flow = await getWeeklyReviewDraft(db, USER_ID);

        expect(flow?.queues.nextActions).toEqual({ pending: [], cursor: 0, decisions: [{ itemId: 'x', undo: { snapshot: undoSnapshot } }, { itemId: 'y' }] });
    });

    it('resumes by stage ID, not ordinal: a draft saved under a different stage order lands on the same stage', async () => {
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'weeklyReview',
            userId: USER_ID,
            updatedTs: '2026-08-23T09:00:00.000Z',
            // A stale ordinal from a build with a different stage order (0 can never be
            // nextActions' slot) — it must lose to the id, or the user resumes on the wrong stage.
            flow: { stageIndex: 0, stageId: 'nextActions', tickedInboxIds: [], queues: {}, skippedStageIds: [], startedTs: '2026-08-23T09:00:00.000Z' },
        });

        const flow = await getWeeklyReviewDraft(db, USER_ID);

        expect(flow?.stageIndex).toBe(stageIndexOf('nextActions'));
        expect(flow?.stageIndex).not.toBe(0);
    });

    it('falls back to the clamped ordinal when the stored stageId is unknown to this build', async () => {
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'weeklyReview',
            userId: USER_ID,
            updatedTs: '2026-08-23T09:00:00.000Z',
            flow: { stageIndex: 99, stageId: 'retiredStage', tickedInboxIds: [], queues: {}, skippedStageIds: [], startedTs: '2026-08-23T09:00:00.000Z' },
        });

        const flow = await getWeeklyReviewDraft(db, USER_ID);

        expect(flow?.stageIndex).toBe(REVIEW_STAGES.length - 1);
    });

    it('clamps an out-of-range stageIndex so resume never lands past the last stage', async () => {
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'weeklyReview',
            userId: USER_ID,
            updatedTs: '2026-08-23T09:00:00.000Z',
            flow: { stageIndex: 99, tickedInboxIds: [], queues: {}, skippedStageIds: [], startedTs: '2026-08-23T09:00:00.000Z' },
        });

        const flow = await getWeeklyReviewDraft(db, USER_ID);

        expect(flow?.stageIndex).toBe(REVIEW_STAGES.length - 1);
    });

    it('ignores a drafts row of a different kind under a colliding key', async () => {
        await db.put('drafts', {
            key: weeklyReviewDraftKey(USER_ID),
            kind: 'inboxCapture',
            userId: USER_ID,
            title: 'not a review draft',
            notes: '',
            updatedTs: '2026-08-23T09:00:00.000Z',
        });

        expect(await getWeeklyReviewDraft(db, USER_ID)).toBeUndefined();
    });
});
