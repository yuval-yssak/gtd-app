import { type RefObject, useLayoutEffect } from 'react';

function fitToContent(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    // Collapsing to `auto` to measure clamps scrollTop on a textarea taller than its max rows; put it
    // back so the view does not jump while the user types.
    const { scrollTop } = textarea;
    textarea.style.blockSize = 'auto';
    // +2 covers the top and bottom hairline borders, which scrollHeight excludes.
    textarea.style.blockSize = `${textarea.scrollHeight + 2}px`;
    textarea.scrollTop = scrollTop;
}

/**
 * Sizes a textarea to its content between its min and max rows (MUI multiline parity; the row
 * bounds live in CSS as `--textarea-min-rows` / `--textarea-max-rows`). It re-measures after every
 * render of the field — a controlled value can change without any input event (live merge, undo),
 * and one layout read per render of a single field is cheap. Returns the handler for typing into an
 * uncontrolled field, which does not re-render.
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>) {
    useLayoutEffect(() => fitToContent(ref.current));
    return () => fitToContent(ref.current);
}
