import { Keyboard } from 'lucide-react';
import { IconButton, Tooltip } from '../designSystem';
import { openShortcutsDialog } from '../lib/shortcutsDialogStore';

/** Opens the app-wide keyboard legend from the sidebar's brand row on every desktop screen (none on phones: touch has no shortcuts). `?` does the same. */
export function KeyboardShortcutsButton() {
    return (
        <Tooltip title="Keyboard shortcuts (?)">
            <IconButton size="sm" aria-label="Keyboard shortcuts" aria-keyshortcuts="?" onClick={openShortcutsDialog} data-testid="keyboardShortcutsButton">
                <Keyboard />
            </IconButton>
        </Tooltip>
    );
}
