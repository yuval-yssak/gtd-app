import { CircleCheck } from 'lucide-react';
import { Button, Card, Text } from '../../designSystem';
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
        <div className={layoutStyles.stageRoot} data-testid="stageEmptyCard">
            <div className={layoutStyles.centeredArea}>
                <Card padding="none" className={styles.emptyCard}>
                    <CircleCheck className={styles.emptyIcon} />
                    <Text variant="titleSm">{title}</Text>
                </Card>
            </div>
            {/* Same pinned bar as the item cards — Continue lands exactly where the primary action
                button just was, so advancing stages never requires repositioning the cursor. */}
            <StageActionBar travel={travel}>
                {onBack && <StageNavButtons onBack={onBack} />}
                <Button variant="solid" onClick={onContinue} data-testid="stageContinue">
                    Continue
                </Button>
            </StageActionBar>
        </div>
    );
}
