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
        <div className={styles.hint} aria-hidden="true" data-testid="goToHint">
            <span className={styles.title}>Go to…</span>
            <ul className={styles.targets}>
                {GO_TO_TARGETS.map((target) => (
                    <li key={target.key}>
                        <kbd className={styles.key}>{target.key}</kbd> {target.label}
                    </li>
                ))}
            </ul>
        </div>
    );
}
