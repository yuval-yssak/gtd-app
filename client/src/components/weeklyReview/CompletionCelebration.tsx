import SelfImprovementIcon from '@mui/icons-material/SelfImprovement';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import confetti from 'canvas-confetti';
import { useEffect } from 'react';
import styles from './CompletionCelebration.module.css';
import { type ReviewFlowState, reviewStats } from './reviewFlowState';

interface CompletionCelebrationProps {
    flow: ReviewFlowState;
    onFinish: () => void;
}

/** The payoff: confetti, per-stage stats, and the "mind like water" message. */
export function CompletionCelebration({ flow, onFinish }: CompletionCelebrationProps) {
    useEffect(() => fireConfetti(), []);

    const stats = reviewStats(flow).filter((stage) => stage.wasSkipped || stage.processedCount > 0);

    return (
        <Box className={styles.celebrationRoot} data-testid="reviewCelebration">
            <Paper elevation={4} className={styles.celebrationCard}>
                <SelfImprovementIcon color="primary" className={styles.mindIcon} />
                <Typography variant="h4" className={styles.headline}>
                    Your mind is clear
                </Typography>
                <Typography variant="body1" color="text.secondary">
                    Everything you're committed to now lives in your trusted system — not in your head. Mind like water.
                </Typography>
                {stats.length > 0 && (
                    <Box className={styles.statsBlock} data-testid="reviewStats">
                        {stats.map((stage) => (
                            <Typography key={stage.stageId} variant="body2" color="text.secondary">
                                {stage.title}: {stage.wasSkipped ? 'skipped' : `${stage.processedCount} reviewed`}
                            </Typography>
                        ))}
                    </Box>
                )}
                {/* autoFocus: entering the celebration unmounts the whole wizard (and the focus-
                    restore hook with it) — seed focus here so the keyboard flow ends on Done. */}
                <Button variant="contained" size="large" autoFocus onClick={onFinish} data-testid="celebrationDone">
                    Done
                </Button>
            </Paper>
        </Box>
    );
}

// Default export for React.lazy — the confetti bundle loads only when a review completes.
export default CompletionCelebration;

/** Fires the bursts and returns a cleanup cancelling the delayed one — clicking Done within 250ms
 *  must not let an ownerless burst append a canvas after the celebration unmounted. */
function fireConfetti(): () => void {
    // Two angled bursts + a center pop — brief and celebratory without looping animation.
    const defaults = { spread: 70, ticks: 200, gravity: 0.9, scalar: 1.1 };
    confetti({ ...defaults, particleCount: 90, origin: { x: 0.2, y: 0.8 }, angle: 60 });
    confetti({ ...defaults, particleCount: 90, origin: { x: 0.8, y: 0.8 }, angle: 120 });
    const delayedBurst = setTimeout(() => confetti({ ...defaults, particleCount: 120, origin: { x: 0.5, y: 0.6 } }), 250);
    return () => clearTimeout(delayedBurst);
}
