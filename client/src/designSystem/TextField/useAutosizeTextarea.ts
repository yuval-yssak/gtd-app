import { type RefObject, useLayoutEffect } from 'react';

function fitToContent(textarea: HTMLTextAreaElement | null) {
    if (!textarea) {
        return;
    }
    // Collapsing to `auto` to measure clamps scrollTop on a textarea capped shorter than its content; put it
    // back so the view does not jump while the user types.
    const { scrollTop } = textarea;
    textarea.style.blockSize = 'auto';
    // The textarea has no border or padding of its own (the shell draws them), but scrollHeight is
    // an integer: a fractional line box (rem line heights under the narrow-screen rem downscaling,
    // browser zoom) can round down and show a scrollbar on an `overflow-y: auto` box. +1 absorbs it.
    textarea.style.blockSize = `${textarea.scrollHeight + 1}px`;
    textarea.scrollTop = scrollTop;
}

/**
 * Sizes a textarea to its content from its min rows up (MUI multiline parity; the row bound
 * lives in CSS as `--textarea-min-rows`, and a caller's class may cap the height). It re-measures after every
 * render of the field — a controlled value can change without any input event (live merge, undo),
 * and one layout read per render of a single field is cheap. Returns the handler for typing into an
 * uncontrolled field, which does not re-render.
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>) {
    useLayoutEffect(() => fitToContent(ref.current));
    return () => fitToContent(ref.current);
}
