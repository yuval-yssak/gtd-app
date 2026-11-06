import { Pause } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../designSystem';
import type { StoredRoutine } from '../../types/MyDB';
import { PauseRoutineConfirmDialog } from '../routines/PauseRoutineConfirmDialog';

interface RoutinePauseActionProps {
    routine: StoredRoutine;
    onConfirmed: () => void;
    disabled: boolean;
}

/** The routine editor's Pause button and its confirm — the same dialog as the routines page row. The editor runs the write. */
export function RoutinePauseAction({ routine, onConfirmed, disabled }: RoutinePauseActionProps) {
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    return (
        <>
            <Button tone="neutral" startIcon={<Pause />} disabled={disabled} onClick={() => setIsConfirmOpen(true)} data-testid="routineEditorPauseButton">
                Pause routine
            </Button>
            <PauseRoutineConfirmDialog
                routine={isConfirmOpen ? routine : null}
                onCancel={() => setIsConfirmOpen(false)}
                onConfirm={() => {
                    setIsConfirmOpen(false);
                    onConfirmed();
                }}
            />
        </>
    );
}
