import { useEffect, useRef } from 'react';
import { isEditableEventTarget } from '../components/quickCapture/quickCaptureLogic';
import { shouldHandlePageEscape } from '../lib/escapeStepOut';
import { isModalOpen } from '../lib/keyboardRegionDom';

interface PageEscapeToCloseOptions {
    enabled: boolean;
    onEscape: () => void;
}

/**
 * ESC-to-leave for the editor pages, which have no modal wrapper to give them ESC-to-close. It
 * stands down (via shouldHandlePageEscape) while any popup or inner dialog is open, and for an ESC
 * from a text field (that one only leaves the field), so ESC always closes the innermost surface first.
 */
export function usePageEscapeToClose({ enabled, onEscape }: PageEscapeToCloseOptions) {
    // Ref-routed so the listener attaches once per `enabled` flip, not per render.
    const onEscapeRef = useRef(onEscape);
    onEscapeRef.current = onEscape;

    useEffect(() => {
        if (!enabled) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }
            if (shouldHandlePageEscape(event, { isModalOpen: isModalOpen(), isEditableTarget: isEditableEventTarget(event.target) })) {
                onEscapeRef.current();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [enabled]);
}
