import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { GO_TO_TARGETS } from '../lib/globalShortcuts';
import styles from './GoToHint.module.css';

/**
 * While a `g` jump is pending: which letter goes where — the jumps are invisible until learned, so
 * they show themselves. Visual only (`aria-hidden`): a live region that arrives already filled is
 * skipped by many screen readers, and one that is read would recite 13 targets on every `g`; the
 * shortcuts legend (`?`) documents the jumps for everyone.
 */
export function GoToHint({ isOpen }: { isOpen: boolean }) {
    if (!isOpen) {
        return null;
    }
    return (
        <Paper elevation={6} className={styles.hint} aria-hidden="true" data-testid="goToHint">
            {/* Plain element: a CSS-module rule on the Typography itself loses to MUI's emotion styles. */}
            <Typography variant="caption" component="div">
                <span className={styles.title}>Go to…</span>
            </Typography>
            <ul className={styles.targets}>
                {GO_TO_TARGETS.map((target) => (
                    <li key={target.key}>
                        <kbd className={styles.key}>{target.key}</kbd> {target.label}
                    </li>
                ))}
            </ul>
        </Paper>
    );
}
