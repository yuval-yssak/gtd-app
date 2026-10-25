import type { ReactNode } from 'react';
import { Text } from '../designSystem';
import styles from './ListEmptyMessage.module.css';

interface ListEmptyMessageProps {
    children: ReactNode;
    'data-testid'?: string | undefined;
}

/** The centred note a list page shows in place of an empty list or a search with no matches. */
export function ListEmptyMessage({ children, 'data-testid': testId }: ListEmptyMessageProps) {
    return (
        <Text tone="secondary" className={styles.message} data-testid={testId}>
            {children}
        </Text>
    );
}
