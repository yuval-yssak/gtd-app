import type { ReactNode } from 'react';
import { Chip, type ChipTone, Text } from '../designSystem';
import styles from './ListPageHeader.module.css';

interface ListPageHeaderProps {
    title: string;
    /** Live row count, shown as a chip after the title; hidden at zero. */
    count?: number | undefined;
    countTone?: ChipTone | undefined;
    /** Sits at the inline-end edge, e.g. "Add person". */
    action?: ReactNode | undefined;
    /** A tighter gap below, for a page whose own controls (the Next Actions filters) follow at once. */
    isCompact?: boolean | undefined;
    /** Beside the title: the sync chip, the search toggle. */
    children?: ReactNode | undefined;
}

/** A list page's title row: the title with its count, the page's adornments, and an optional action. */
export function ListPageHeader({ title, count = 0, countTone, action, isCompact = false, children }: ListPageHeaderProps) {
    return (
        <div className={styles.header} data-compact={isCompact || undefined}>
            <div className={styles.titleGroup}>
                <Text variant="title">
                    {title}
                    {count > 0 && <Chip label={count} tone={countTone} className={styles.countChip} />}
                </Text>
                {children}
            </div>
            {action}
        </div>
    );
}
