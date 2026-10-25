import { useEffect, useRef } from 'react';
import { shouldHandlePageEscape } from '../components/itemEditor/itemEditorLogic';
import { isModalOpen } from '../lib/keyboardRegionDom';

interface PageEscapeToCloseOptions {
    enabled: boolean;
    onEscape: () => void;
}

/**
 * ESC-to-leave for the editor pages, which have no modal wrapper to give them ESC-to-close. It
 * stands down (via shouldHandlePageEscape) while any popup or inner dialog is open, so ESC always
 * closes the innermost surface first.
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
            if (shouldHandlePageEscape(event, isModalOpen())) {
                onEscapeRef.current();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [enabled]);
}
