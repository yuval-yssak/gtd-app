import { useEffect, useRef } from 'react';
import { shouldHandlePageEscape } from '../components/editItemDialogLogic';

interface PageEscapeToCloseOptions {
    enabled: boolean;
    onEscape: () => void;
}

/**
 * Page-chrome ESC-to-leave. Dialog/popover editor chromes get ESC-to-close from MUI Modal; the
 * full-page route has no modal wrapper, so this document-level listener fills the gap. It stands
 * down (via shouldHandlePageEscape) while any MUI popup or inner dialog is open, so ESC always
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
            // :not([aria-hidden]) — keep-mounted modals (AppNav's mobile drawer) sit in the DOM
            // permanently; MUI marks them aria-hidden while closed, so bare presence ≠ open.
            if (shouldHandlePageEscape(event, document.querySelector('.MuiModal-root:not([aria-hidden="true"])') !== null)) {
                onEscapeRef.current();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [enabled]);
}
