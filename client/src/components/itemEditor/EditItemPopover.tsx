import Popover from '@mui/material/Popover';
import { ItemEditorBody, type ItemEditorBodyProps } from './ItemEditorBody';

interface Props extends Omit<ItemEditorBodyProps, 'chrome'> {
    anchorEl: HTMLElement;
}

/**
 * Floating popover variant of the item editor — anchored to the row/chip the user clicked.
 * Anchor origin/transform-origin match the legacy inbox popover so existing visual expectations
 * are preserved. Pass `key={item._id}` on the parent so the body remounts when the editor opens
 * on a different item — otherwise local form state would seed from the wrong item.
 */
export function EditItemPopover({ anchorEl, ...bodyProps }: Props) {
    return (
        <Popover
            open
            anchorEl={anchorEl}
            onClose={bodyProps.onClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
            <ItemEditorBody {...bodyProps} chrome="popover" />
        </Popover>
    );
}
