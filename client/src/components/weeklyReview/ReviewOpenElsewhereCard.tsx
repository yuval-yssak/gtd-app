import { MonitorSmartphone, Play } from 'lucide-react';
import { Button, Card, Text } from '../../designSystem';
import styles from './ReviewOpenElsewhereCard.module.css';

interface ReviewOpenElsewhereCardProps {
    /** Takes the review over from the other tab, which steps aside. */
    onContinueHere: () => void;
}

/** Shown in every tab but the one running the weekly review — only one tab owns it at a time. */
export function ReviewOpenElsewhereCard({ onContinueHere }: ReviewOpenElsewhereCardProps) {
    return (
        <div className={styles.wrapper}>
            <Card padding="none" className={styles.card} data-testid="reviewOpenElsewhere">
                <MonitorSmartphone size={32} aria-hidden />
                <Text as="h1" variant="headline" weight="bold">
                    Weekly Review is open in another tab
                </Text>
                <Text tone="secondary">Only one tab runs the review at a time, so the two never overwrite each other's progress.</Text>
                <Button variant="solid" size="lg" startIcon={<Play />} onClick={onContinueHere} data-testid="continueReviewHereButton">
                    Continue here
                </Button>
            </Card>
        </div>
    );
}
