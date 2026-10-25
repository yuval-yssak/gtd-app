import type { Meta, StoryObj } from '@storybook/react';
import { SYNC_RECOVERY_IDLE, type SyncRecoveryState, setSyncRecoveryState } from '../contexts/syncRecoveryStore';
import { mockDb } from '../test-utils/storybookMocks';
import { SyncRecoveryDialog } from './SyncRecoveryDialog';

/** Primes the module-level recovery store for one story and resets it to idle afterwards. */
const inPhase = (phase: Exclude<SyncRecoveryState, { phase: 'idle' }>) => () => {
    setSyncRecoveryState(phase);
    return () => setSyncRecoveryState(SYNC_RECOVERY_IDLE);
};

const meta = {
    title: 'Components/SyncRecoveryDialog',
    component: SyncRecoveryDialog,
    args: { db: mockDb },
} satisfies Meta<typeof SyncRecoveryDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No recovery in progress — nothing renders. */
export const Idle: Story = {};

/** Reaped device with no queued changes — the automatic full sync is running. */
export const Case1Syncing: Story = {
    beforeEach: inPhase({ phase: 'case1Syncing', userId: 'user-1' }),
};

/** Reaped device holding offline changes — the user picks push, discard, or export first. */
export const Case2Choice: Story = {
    beforeEach: inPhase({ phase: 'case2Choice', userId: 'user-1', queuedOpCount: 3 }),
};

/** "Push my offline changes" chosen — the queued ops are being flushed. */
export const Flushing: Story = {
    beforeEach: inPhase({ phase: 'flushing', userId: 'user-1', queuedOpCount: 3 }),
};

/** The flush was rejected — nothing discarded; retry, export or discard. */
export const FlushFailed: Story = {
    beforeEach: inPhase({
        phase: 'flushFailed',
        userId: 'user-1',
        queuedOpCount: 2,
        errorMessage: 'POST /sync/push 400',
        failedOpSummaries: ['Update item “Draft the project proposal”', 'Create item “Call the dentist”'],
    }),
};

/** Flush or discard done — the full bootstrap is in flight. */
export const Bootstrapping: Story = {
    beforeEach: inPhase({ phase: 'bootstrapping', userId: 'user-1' }),
};

/** The full sync threw — a retry keeps the app from staying locked. */
export const BootstrapFailed: Story = {
    beforeEach: inPhase({ phase: 'bootstrapFailed', userId: 'user-1', errorMessage: 'Failed to fetch' }),
};
