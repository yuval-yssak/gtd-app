import LoopIcon from '@mui/icons-material/Loop';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import { useNavigate } from '@tanstack/react-router';
import { useRoutineIndicatorStyle } from '../lib/routineIndicatorStyle';
import styles from './RoutineIndicator.module.css';

interface Props {
    routineId: string;
    // exactOptionalPropertyTypes requires explicit `| undefined` to allow passing `.find()?.title`
    routineTitle?: string | undefined;
    // Editor surfaces force the chip so the routine link is always reachable there — the
    // user's list-indicator style setting ('none' etc.) only governs list rows.
    forceChip?: boolean;
}

export function RoutineIndicator({ routineId, routineTitle, forceChip = false }: Props) {
    const navigate = useNavigate();
    const listStyle = useRoutineIndicatorStyle();
    const style = forceChip ? 'chip' : listStyle;

    if (style === 'none') {
        return null;
    }

    const label = routineTitle ? `Routine: ${routineTitle}` : 'Part of a routine';

    function onClick(e: React.MouseEvent) {
        // Stop propagation so clicking the indicator doesn't trigger the parent item row action.
        e.stopPropagation();
        void navigate({ to: '/routine/$routineId', params: { routineId } });
    }

    if (style === 'chip') {
        return (
            <Tooltip title={label}>
                <Chip icon={<LoopIcon />} label="Routine" size="small" variant="outlined" onClick={onClick} className={styles.chip} />
            </Tooltip>
        );
    }

    if (style === 'colorAccent') {
        return (
            <Tooltip title={label}>
                {/* Use a button element for semantic correctness and focusability */}
                <button type="button" className={styles.colorAccent} onClick={onClick} aria-label={label} />
            </Tooltip>
        );
    }

    // Default: icon — wrap in button for accessible keyboard navigation
    return (
        <Tooltip title={label}>
            <button type="button" className={styles.iconButton} onClick={onClick} aria-label={label}>
                <LoopIcon fontSize="small" className={styles.icon} />
            </button>
        </Tooltip>
    );
}
