import Popover from '@mui/material/Popover';
import { RoutineEditorBody, type RoutineEditorBodyProps } from './RoutineEditorBody';

interface Props extends Omit<RoutineEditorBodyProps, 'chrome'> {
    anchorEl: HTMLElement;
}

/**
 * Floating popover variant of the routine editor — anchored to the row the user clicked.
 * Anchor origin/transform-origin match the item editor popover so visual expectations are
 * consistent across the two editors. Pass `key={routine?._id ?? 'new'}` on the parent so the
 * body remounts when the editor opens on a different routine — otherwise local form state would
 * seed from the wrong routine.
 */
export function RoutineEditorPopover({ anchorEl, ...bodyProps }: Props) {
    return (
        <Popover
            open
            anchorEl={anchorEl}
            onClose={bodyProps.onClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
            <RoutineEditorBody {...bodyProps} chrome="popover" />
        </Popover>
    );
}
