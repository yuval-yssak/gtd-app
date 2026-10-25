import { ArrowLeft } from 'lucide-react';
import { IconButton, Text } from '../designSystem';
import styles from './DetailPageHeader.module.css';
import { CopyIdButton } from './itemEditor/CopyIdButton';

interface DetailPageHeaderProps {
    title: string;
    onBack: () => void;
    /** The entity's id, when there is one to copy — a create page has none yet. */
    idForCopy?: string | undefined;
}

/** Back arrow, page title and copy-id button shared by the item, person and routine pages. */
export function DetailPageHeader({ title, onBack, idForCopy }: DetailPageHeaderProps) {
    return (
        <div className={styles.header}>
            <IconButton size="sm" onClick={onBack} aria-label="Go back">
                <ArrowLeft />
            </IconButton>
            <Text variant="titleSm" weight="semibold" className={styles.title}>
                {title}
            </Text>
            {idForCopy && <CopyIdButton id={idForCopy} />}
        </div>
    );
}
