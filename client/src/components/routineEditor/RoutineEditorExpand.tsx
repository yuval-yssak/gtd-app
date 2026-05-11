import Collapse from '@mui/material/Collapse';
import { RoutineEditorBody, type RoutineEditorBodyProps } from './RoutineEditorBody';

type Props = Omit<RoutineEditorBodyProps, 'chrome'>;

/**
 * Inline expand variant of the routine editor — rendered directly under the clicked row by the
 * host page (via `useRoutineEditor.renderExpandFor`). Pass `key={routine?._id ?? 'new'}` on the
 * parent so the body remounts when the editor opens on a different routine.
 */
export function RoutineEditorExpand(props: Props) {
    return (
        <Collapse in>
            <RoutineEditorBody {...props} chrome="expand" />
        </Collapse>
    );
}
