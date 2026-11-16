import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton, Text } from '../designSystem';
import styles from './DetailPageHeader.module.css';
import { CopyIdButton } from './itemEditor/CopyIdButton';

interface DetailPageHeaderProps {
    title: string;
    onBack: () => void;
    /** The entity's id, when there is one to copy — a create page has none yet. */
    idForCopy?: string | undefined;
    /** Status shown beside the title, e.g. whether the entity has been checked with the server. */
    badge?: ReactNode;
}

/** Back arrow, page title, optional status badge and copy-id button shared by the item, person and routine pages. */
export function DetailPageHeader({ title, onBack, idForCopy, badge }: DetailPageHeaderProps) {
    return (
        <div className={styles.header}>
            <IconButton size="sm" onClick={onBack} aria-label="Go back" data-testid="detailBackButton">
                <ArrowLeft />
            </IconButton>
            <Text as="h1" variant="titleSm" weight="semibold" className={styles.title}>
                {title}
            </Text>
            {badge}
            {idForCopy && <CopyIdButton id={idForCopy} />}
        </div>
    );
}
