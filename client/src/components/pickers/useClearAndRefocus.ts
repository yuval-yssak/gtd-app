import { type MouseEvent, useRef } from 'react';

/**
 * Empties a field and, only when Clear was activated from the keyboard, hands focus back to its
 * input. Enter/Space synthesise a click with `detail === 0` (no pointer count); that is the one
 * case where focus needs rescuing, because the Clear button unmounts from under the keyboard user
 * ("keyboard" here means any non-pointer activation — screen-reader clicks also report detail 0).
 * A pointer user keeps their focus where it is: on iOS, focusing a native date/time input inside a
 * tap opens its picker, and dismissing that picker can write a date straight back into the field
 * that was just cleared.
 */
export function clearFieldAndRefocus(onChange: (next: string) => void, input: Pick<HTMLInputElement, 'focus'> | null, activation: { detail: number }) {
    onChange('');
    if (activation.detail === 0) {
        input?.focus();
    }
}

/** Clear handler + input ref for a field whose Clear button unmounts itself once the value is empty. */
export function useClearAndRefocus(onChange: (next: string) => void) {
    const inputRef = useRef<HTMLInputElement>(null);
    const onCleared = (event: MouseEvent<HTMLButtonElement>) => clearFieldAndRefocus(onChange, inputRef.current, event);
    return { inputRef, onCleared };
}
