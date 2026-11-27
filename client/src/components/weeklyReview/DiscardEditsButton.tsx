import type { RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '../../designSystem';

interface DiscardEditsButtonProps {
    /** The editor's `discardEdits` — re-seeds the form from the stored item. */
    onDiscard: () => void;
    /**
     * The host action that takes focus afterwards. This button renders only while edits exist, so
     * it unmounts with them; without a hand-off, keyboard focus would fall to <body>.
     */
    focusAfter: RefObject<HTMLButtonElement | null>;
    disabled?: boolean | undefined;
    testId: string;
}

/**
 * The deliberate way NOT to save in the weekly review: the inline editors never navigate, so no
 * unsaved-changes prompt can guard them, and every action that would leave an edited card is
 * locked until the user picks Save or this. The discard commits synchronously so the host's
 * re-enabled action exists to receive focus.
 */
export function DiscardEditsButton({ onDiscard, focusAfter, disabled, testId }: DiscardEditsButtonProps) {
    function onDiscardChosen() {
        flushSync(onDiscard);
        focusAfter.current?.focus();
    }
    return (
        <Button disabled={disabled} onClick={onDiscardChosen} data-testid={testId}>
            Discard
        </Button>
    );
}
