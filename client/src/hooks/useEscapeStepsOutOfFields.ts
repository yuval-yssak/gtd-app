import { useEffect } from 'react';
import { isEditableEventTarget } from '../components/quickCapture/quickCaptureLogic';
import { shouldStepIntoField, shouldStepOutOfField } from '../lib/escapeStepOut';
import { FIELD_PARKING_ATTR, isModalOpen, parkingSpotOf, textControlIn } from '../lib/keyboardRegionDom';

/**
 * App-wide: Escape in a text field takes focus out of it, so keyboard navigation resumes without
 * Tab (which the notes editor keeps for indenting). Focus parks on the field's box when it has one
 * — Enter steps back in — and otherwise leaves the field for the page. Listens in the BUBBLE
 * phase on the window — after the field's own handlers — so a field that claims Escape (closing
 * its popup, committing a value) preventDefaults and keeps focus.
 */
export function useEscapeStepsOutOfFields() {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.target instanceof HTMLElement)) {
                return;
            }
            if (shouldStepOutOfField(event, { isEditableTarget: isEditableEventTarget(event.target), isModalOpen: isModalOpen() })) {
                stepOutOf(event.target);
                return;
            }
            if (shouldStepIntoField(event, { isParkedOnField: event.target.hasAttribute(FIELD_PARKING_ATTR), isModalOpen: isModalOpen() })) {
                stepInto(event.target, event);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);
}

/** Claims the Enter only when there is a control to land in (none while the editor chunk loads). */
function stepInto(spot: HTMLElement, event: KeyboardEvent) {
    const control = textControlIn(spot);
    if (!control) {
        return;
    }
    // The Enter must not also reach the field it lands in (submitting a capture, inserting a line).
    event.preventDefault();
    control.focus();
}

function stepOutOf(field: HTMLElement) {
    const spot = parkingSpotOf(field);
    if (spot) {
        spot.focus();
        return;
    }
    field.blur();
}
