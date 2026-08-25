import EditIcon from '@mui/icons-material/Edit';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import type { MyDB } from '../../types/MyDB';
import styles from './InboxChecklistStage.module.css';
import { ManageInboxesDialog } from './ManageInboxesDialog';
import { isChecklistComplete } from './reviewFlowState';
import { StageActionBar, type StageTravel } from './StageActionBar';
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
    const allTicked = isChecklistComplete(
        tickedInboxIds,
        myInboxes.map((inbox) => inbox._id),
    );

    return (
        <Box className={layoutStyles.stageRoot} data-testid="inboxChecklistStage">
            <Paper elevation={2} className={styles.checklistCard}>
                {myInboxes.map((inbox) => (
                    <FormControlLabel
                        key={inbox._id}
                        control={<Checkbox checked={tickedInboxIds.includes(inbox._id)} onChange={() => onToggleTick(inbox._id)} />}
                        label={<Typography>{inbox.name}</Typography>}
                        data-testid="reviewInboxRow"
                    />
                ))}
                <Button
                    size="small"
                    startIcon={<EditIcon />}
                    className={styles.manageButton}
                    onClick={() => setIsManaging(true)}
                    data-testid="manageInboxesButton"
                >
                    Edit inboxes
                </Button>
            </Paper>
            {/* Same pinned bar position as every other stage's primary action / Continue. The
                travel ▶ lets the user move on without ticking every bucket (no skip mark). */}
            <StageActionBar travel={travel}>
                <Button variant="contained" disabled={!allTicked} onClick={onStageFinished} data-testid="stageContinue">
                    All inboxes clear — continue
                </Button>
            </StageActionBar>

            {isManaging && <ManageInboxesDialog db={db} onClose={() => setIsManaging(false)} />}
        </Box>
    );
}
