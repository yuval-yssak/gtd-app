import KeyboardIcon from '@mui/icons-material/KeyboardOutlined';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { openShortcutsDialog } from '../lib/shortcutsDialogStore';

/** Opens the app-wide keyboard legend from the sidebar's brand row on every desktop screen (none on phones: touch has no shortcuts). `?` does the same. */
export function KeyboardShortcutsButton() {
    return (
        <Tooltip title="Keyboard shortcuts (?)">
            <IconButton size="small" aria-label="Keyboard shortcuts" aria-keyshortcuts="?" onClick={openShortcutsDialog} data-testid="keyboardShortcutsButton">
                <KeyboardIcon fontSize="small" />
            </IconButton>
        </Tooltip>
    );
}
