import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { StageActionBar, type StageTravel } from './StageActionBar';
import styles from './StageEmptyCard.module.css';
import { StageNavButtons } from './StageNavButtons';
import layoutStyles from './stageLayout.module.css';

interface StageEmptyCardProps {
    title: string;
    onContinue: () => void;
    /** Steps back into this stage's decision history — a wrong call must stay reachable even from "All reviewed!". */
    onBack?: (() => void) | undefined;
    travel: StageTravel;
}

/** Shown when a stage's queue is exhausted (or was empty to begin with) — the gate to the next stage. */
export function StageEmptyCard({ title, onContinue, onBack, travel }: StageEmptyCardProps) {
    return (
        <Box className={layoutStyles.stageRoot} data-testid="stageEmptyCard">
            <Box className={layoutStyles.centeredArea}>
                <Paper elevation={1} className={styles.emptyCard}>
                    <CheckCircleOutlineIcon color="success" className={styles.emptyIcon} />
                    <Typography variant="h6">{title}</Typography>
                </Paper>
            </Box>
            {/* Same pinned bar as the item cards — Continue lands exactly where the primary action
                button just was, so advancing stages never requires repositioning the cursor. */}
            <StageActionBar travel={travel}>
                {onBack && <StageNavButtons onBack={onBack} />}
                <Button variant="contained" onClick={onContinue} data-testid="stageContinue">
                    Continue
                </Button>
            </StageActionBar>
        </Box>
    );
}
