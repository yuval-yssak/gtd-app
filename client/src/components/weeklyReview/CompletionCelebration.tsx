import confetti from 'canvas-confetti';
import { Waves } from 'lucide-react';
import { useEffect } from 'react';
import { Button, Card, Text } from '../../designSystem';
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
        <div className={styles.celebrationRoot} data-testid="reviewCelebration">
            <Card padding="none" className={styles.celebrationCard}>
                <Waves className={styles.mindIcon} />
                <Text variant="headline" weight="bold">
                    Your mind is clear
                </Text>
                <Text tone="secondary">Everything you're committed to now lives in your trusted system — not in your head. Mind like water.</Text>
                {stats.length > 0 && (
                    <div className={styles.statsBlock} data-testid="reviewStats">
                        {stats.map((stage) => (
                            <Text key={stage.stageId} variant="bodySm" tone="secondary">
                                {stage.title}: {stage.wasSkipped ? 'skipped' : `${stage.processedCount} reviewed`}
                            </Text>
                        ))}
                    </div>
                )}
                {/* autoFocus: entering the celebration unmounts the whole wizard (and the focus-
                    restore hook with it) — seed focus here so the keyboard flow ends on Done. */}
                <Button variant="solid" size="lg" autoFocus onClick={onFinish} data-testid="celebrationDone">
                    Done
                </Button>
            </Card>
        </div>
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
