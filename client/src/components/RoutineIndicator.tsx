import { Repeat } from 'lucide-react';
import type { MouseEvent } from 'react';
import { Chip, Tooltip } from '../designSystem';
import { useNewTabAwareNavigate } from '../lib/newTabNavigation';
import { useRoutineIndicatorStyle } from '../lib/routineIndicatorStyle';
import styles from './RoutineIndicator.module.css';

interface Props {
    routineId: string;
    routineTitle?: string | undefined;
    /**
     * Editor surfaces force the chip so the routine link is always reachable there — the user's
     * list-indicator style setting ('none' etc.) only governs list rows.
     */
    forceChip?: boolean | undefined;
}

export function RoutineIndicator({ routineId, routineTitle, forceChip = false }: Props) {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const listStyle = useRoutineIndicatorStyle();
    const style = forceChip ? 'chip' : listStyle;

    if (style === 'none') {
        return null;
    }

    const label = routineTitle ? `Routine: ${routineTitle}` : 'Part of a routine';

    function onClick(e: MouseEvent) {
        // Stop propagation so clicking the indicator doesn't trigger the parent item row action.
        e.stopPropagation();
        navigateOrNewTab(e, { to: '/routine/$routineId', params: { routineId } });
    }

    if (style === 'chip') {
        return (
            <Tooltip title={label}>
                <Chip icon={<Repeat />} label="Routine" variant="outline" onClick={onClick} className={styles.chip} />
            </Tooltip>
        );
    }

    if (style === 'colorAccent') {
        return (
            <Tooltip title={label}>
                <button type="button" className={styles.colorAccent} onClick={onClick} aria-label={label} />
            </Tooltip>
        );
    }

    return (
        <Tooltip title={label}>
            <button type="button" className={styles.iconButton} onClick={onClick} aria-label={label}>
                <Repeat size={18} aria-hidden="true" />
            </button>
        </Tooltip>
    );
}
