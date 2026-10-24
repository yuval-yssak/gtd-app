import { ArrowLeft } from 'lucide-react';
import { IconButton, Text } from '../../designSystem';
import { CopyIdButton } from '../itemEditor/CopyIdButton';
import styles from './RoutinePageHeader.module.css';

interface RoutinePageHeaderProps {
    title: string;
    onBack: () => void;
    /** The routine's id, when there is one to copy — the create page has none yet. */
    idForCopy?: string | undefined;
}

/** Back arrow, page title and copy-id button shared by the routine create and edit pages. */
export function RoutinePageHeader({ title, onBack, idForCopy }: RoutinePageHeaderProps) {
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
