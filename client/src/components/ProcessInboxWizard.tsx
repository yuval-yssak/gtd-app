import type { IDBPDatabase } from 'idb';
import { useCallback, useRef, useState } from 'react';
import { usePendingReassign } from '../contexts/PendingReassignProvider';
import { FROM_GMAIL_READONLY_MESSAGE } from '../db/itemMutations';
import { Button, Callout, Text } from '../designSystem';
import { useFinishOnce } from '../hooks/useFinishOnce';
import { showAppNotice } from '../lib/appNotice';
import type { MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import { type ItemEditorActionsApi, ItemEditorBody } from './itemEditor/ItemEditorBody';
import styles from './ProcessInboxWizard.module.css';

interface ProcessInboxWizardProps {
    items: StoredItem[];
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onItemProcessed: () => Promise<void>;
}

export type WizardStep = { kind: 'item'; index: number; itemId: string; isLast: boolean } | { kind: 'done' };

/**
 * Pure progression — what step is the wizard on, given a list of items and a current index?
 * Extracted so the index/done transition can be tested without rendering the body.
 */
export function nextWizardStep(items: ReadonlyArray<StoredItem>, index: number): WizardStep {
    if (index >= items.length) {
        return { kind: 'done' };
    }
    const current = items[index];
    if (!current) {
        return { kind: 'done' };
    }
    return { kind: 'item', index, itemId: current._id, isLast: index + 1 >= items.length };
}

/** How a finished run went: items walked, and how many of them were skipped (left in the inbox). */
interface RunTally {
    total: number;
    skipped: number;
}

/**
 * The toast the run ends on, back in the inbox. It claims a clear inbox only when nothing was
 * skipped — skipped items are plainly still listed there. A Gmail read-only warning the LAST item
 * raised rides along: the run navigates away as it finishes, so a separate toast would be replaced.
 */
export function runSummaryNotice({ total, skipped }: RunTally, hasReadonlyWarning: boolean): string {
    const summary =
        skipped === 0
            ? `Inbox clear! All ${total} item${total === 1 ? '' : 's'} processed.`
            : `Processed ${total - skipped} of ${total} — ${skipped} still in the inbox.`;
    return hasReadonlyWarning ? `${summary} ${FROM_GMAIL_READONLY_MESSAGE}` : summary;
}

/**
 * Sequential wizard over inbox items. Hosts the universal ItemEditorBody for the current item so
 * each item gets the full status-chip / forms / cross-account picker — same UX as single-item
 * editing on every other list page. Mounted full-page by the /process-inbox route; the
 * "Save & next" / "Skip" actions advance to the next item via a body remount on the index change.
 */
export function ProcessInboxWizard({ items, db, people, workContexts, onClose, onItemProcessed }: ProcessInboxWizardProps) {
    const [index, setIndex] = useState(0);
    const step = nextWizardStep(items, index);
    const { isPending } = usePendingReassign();
    const [skippedCount, setSkippedCount] = useState(0);
    // Set when the last item's save raised the Gmail read-only warning, so the closing toast carries
    // it. Safe to read at the finish: the warning fires during the save, before the body's onClose
    // advances past the last item.
    const lastItemReadonlyRef = useRef(false);

    const advance = useCallback(() => {
        setIndex((i) => i + 1);
    }, []);
    const skip = useCallback(() => {
        setSkippedCount((n) => n + 1);
        advance();
    }, [advance]);

    // ItemEditorBody schedules `onSaved()` then `onClose()` once a save commits. By passing
    // refresh+advance as the close handler, "Save & next" is the body's normal save path with
    // the wizard's progression piggy-backed on top — no parallel save logic to maintain.
    //
    // IMPORTANT: cross-account reassigns inside the body are fire-and-forget — `onClose()` runs
    // synchronously and `onSaved()` is chained off the post-flight promise. The wizard advances
    // before the move resolves; the PendingReassignProvider overlay covers the visual gap.
    const onSavedItem = useCallback(async () => {
        await onItemProcessed();
    }, [onItemProcessed]);

    // Whether the current item committed an EXPLICIT save. The body also closes on Escape and on a
    // reassign kickoff; like the weekly review, only an explicit save counts as processing the
    // item — every other close steps past it and counts it as skipped.
    const hasSaveCommittedRef = useRef(false);
    const onSaveCommitted = useCallback(() => {
        hasSaveCommittedRef.current = true;
    }, []);

    const onCloseItem = useCallback(() => {
        const hasSaveCommitted = hasSaveCommittedRef.current;
        hasSaveCommittedRef.current = false;
        if (hasSaveCommitted) {
            advance();
            return;
        }
        skip();
    }, [advance, skip]);

    // Finished: back to the inbox, where an app-wide toast (it outlives this page) reports the run.
    // Once only — the page can re-render (a late items refresh) while that navigation commits.
    useFinishOnce(step.kind === 'done', () => {
        showAppNotice(runSummaryNotice({ total: items.length, skipped: skippedCount }, lastItemReadonlyRef.current));
        onClose();
    });

    if (step.kind === 'done') {
        return null;
    }

    const currentItem = items[step.index];
    if (!currentItem) {
        // nextWizardStep already guarantees this, but TS needs the narrowing.
        return null;
    }
    const reassignInFlight = isPending('item', currentItem._id);

    const renderActions = (api: ItemEditorActionsApi) => <WizardActions isLast={step.isLast} api={api} onSkip={skip} onAbort={onClose} />;

    // When the current item is mid-reassign the body refuses to render the editor (it would
    // misroute writes under the target user). The wizard must still surface Skip so the user
    // can move past the in-flight item — otherwise the only available gesture is Cancel,
    // which loses all wizard progression.
    const inFlightContent = reassignInFlight ? <ReassignInFlightWizardBody isLast={step.isLast} onSkip={skip} onAbort={onClose} /> : null;

    const editorBody = (
        <ItemEditorBody
            key={`${currentItem._id}:${step.index}`}
            item={currentItem}
            db={db}
            people={people}
            workContexts={workContexts}
            onClose={onCloseItem}
            onSaved={onSavedItem}
            onSaveCommitted={onSaveCommitted}
            onFromGmailReadOnly={() => {
                if (step.isLast) {
                    lastItemReadonlyRef.current = true;
                } else {
                    showAppNotice(FROM_GMAIL_READONLY_MESSAGE);
                }
            }}
            renderActions={renderActions}
        />
    );

    return (
        <div className={styles.pageRoot} data-testid="processInboxPage">
            <WizardHeader index={step.index} total={items.length} />
            <div className={styles.pageBody}>{inFlightContent ?? editorBody}</div>
        </div>
    );
}

interface WizardHeaderProps {
    index: number;
    total: number;
}

function WizardHeader({ index, total }: WizardHeaderProps) {
    return (
        <div className={styles.headerRow}>
            <div className={styles.headerTextBlock}>
                <Text as="h1" variant="titleSm" weight="semibold">
                    Process Inbox
                </Text>
                <Text as="span" variant="caption" tone="secondary">
                    {index + 1} of {total}
                </Text>
            </div>
            {/* No header CopyIdButton here: the wizard passes no `hasHostCopyIdButton`, so
                ItemEditorBody's meta row renders the copy button for this host. */}
        </div>
    );
}

interface WizardActionsProps {
    isLast: boolean;
    api: ItemEditorActionsApi;
    onSkip: () => void;
    onAbort: () => void;
}

function WizardActions({ isLast, api, onSkip, onAbort }: WizardActionsProps) {
    const saveLabel = isLast ? 'Save & finish' : 'Save & next';
    return (
        <>
            <Button variant="ghost" tone="neutral" onClick={onAbort} disabled={api.isSaving} data-testid="processInboxExit">
                Exit
            </Button>
            <Button variant="ghost" tone="neutral" onClick={onSkip} disabled={api.isSaving} data-testid="processInboxSkip">
                Skip{isLast ? ' & finish' : ' for now'}
            </Button>
            <Button variant="solid" disabled={api.saveDisabled} onClick={api.triggerSave} data-testid="processInboxSaveNext">
                {saveLabel}
            </Button>
        </>
    );
}

interface ReassignInFlightWizardBodyProps {
    isLast: boolean;
    onSkip: () => void;
    onAbort: () => void;
}

/** In-flight branch — the body would seed ownerUserId from the overlayed (target) user, so the
 *  wizard refuses the edit but keeps Skip / Exit reachable so the user isn't trapped. */
function ReassignInFlightWizardBody({ isLast, onSkip, onAbort }: ReassignInFlightWizardBodyProps) {
    return (
        <div className={styles.inFlightBody}>
            <Callout tone="info" variant="outline">
                This item is being moved to another account. You can edit it once the move completes — skip past it for now.
            </Callout>
            <div className={styles.inFlightActions}>
                <Button variant="ghost" tone="neutral" onClick={onAbort} data-testid="processInboxExit">
                    Exit
                </Button>
                <Button variant="solid" onClick={onSkip} data-testid="processInboxSkip">
                    Skip{isLast ? ' & finish' : ' for now'}
                </Button>
            </div>
        </div>
    );
}
