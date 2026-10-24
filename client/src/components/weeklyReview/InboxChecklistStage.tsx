import type { IDBPDatabase } from 'idb';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { Button, Card, Checkbox, Text } from '../../designSystem';
import { hasAtLeastOne } from '../../lib/typeUtils';
import type { MyDB } from '../../types/MyDB';
import styles from './InboxChecklistStage.module.css';
import { ManageInboxesDialog } from './ManageInboxesDialog';
import { isChecklistComplete } from './reviewFlowState';
import { StageActionBar, type StageTravel } from './StageActionBar';
import { StageCardScroller } from './StageCardScroller';
import layoutStyles from './stageLayout.module.css';

interface InboxChecklistStageProps {
    db: IDBPDatabase<MyDB>;
    tickedInboxIds: string[];
    onToggleTick: (inboxId: string) => void;
    onStageFinished: () => void;
    travel: StageTravel;
}

/**
 * Stage 1 — clear every EXTERNAL capture bucket into the GTD inbox. Each user-defined inbox is a
 * tick-off row; the stage completes when everything is ticked (or is skipped wholesale). The GTD
 * inbox itself is deliberately absent — emptying it IS the next stage (Clarify).
 */
export function InboxChecklistStage({ db, tickedInboxIds, onToggleTick, onStageFinished, travel }: InboxChecklistStageProps) {
    // allReviewInboxes (not the hidden-filtered set): the review runs on the ACTIVE account, and it
    // must keep working even while that account is display-hidden — the filtered set would show
    // an empty checklist.
    const { account, allReviewInboxes } = useAppData();
    const [isManaging, setIsManaging] = useState(false);

    const myInboxes = allReviewInboxes.filter((inbox) => inbox.userId === account?.id);
    const hasExternalInboxes = hasAtLeastOne(myInboxes);
    const allTicked = isChecklistComplete(
        tickedInboxIds,
        myInboxes.map((inbox) => inbox._id),
    );

    return (
        <div className={layoutStyles.stageRoot} data-testid="inboxChecklistStage">
            <StageCardScroller>
                <Card padding="none" className={styles.checklistCard}>
                    {hasExternalInboxes ? (
                        myInboxes.map((inbox) => (
                            <Checkbox
                                key={inbox._id}
                                label={inbox.name}
                                checked={tickedInboxIds.includes(inbox._id)}
                                onCheckedChange={() => onToggleTick(inbox._id)}
                                data-testid="reviewInboxRow"
                            />
                        ))
                    ) : (
                        <Text tone="secondary" data-testid="emptyChecklistMessage">
                            No external inboxes to clear — add one with “Edit inboxes”, or just continue.
                        </Text>
                    )}
                    <Button
                        size="sm"
                        startIcon={<Pencil />}
                        className={styles.manageButton}
                        onClick={() => setIsManaging(true)}
                        data-testid="manageInboxesButton"
                    >
                        Edit inboxes
                    </Button>
                </Card>
            </StageCardScroller>
            {/* Same pinned bar position as every other stage's primary action / Continue. The
                travel ▶ lets the user move on without ticking every bucket (no skip mark). */}
            <StageActionBar travel={travel}>
                <Button variant="solid" disabled={!allTicked} onClick={onStageFinished} data-testid="stageContinue">
                    {/* With no buckets there is nothing to declare "clear" — the tick-off claim would be false. */}
                    {hasExternalInboxes ? 'All inboxes clear — continue' : 'Continue'}
                </Button>
            </StageActionBar>

            {isManaging && <ManageInboxesDialog db={db} onClose={() => setIsManaging(false)} />}
        </div>
    );
}
