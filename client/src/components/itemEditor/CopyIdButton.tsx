import { ROW_ACTION_KEYS, rowActionButtonProps } from '../../lib/rowShortcuts';
import { CopyButton, type CopyButtonProps } from '../CopyButton';

interface Props {
    id: string;
    // Optional override so list-row instances can have distinct selectors while the editor/page
    // headers keep the default `copyItemIdButton` testid that existing tests depend on.
    testId?: string;
    buttonProps?: CopyButtonProps['buttonProps'];
    /** On a list row: the C key presses it, and its tooltip says so. Editor and page headers have no row, so no shortcut. */
    isRowAction?: boolean;
}

/** Copy-to-clipboard icon for an entity ID; the success Snackbar echoes the ID so the user sees what was copied. */
export function CopyIdButton({ id, testId = 'copyItemIdButton', buttonProps, isRowAction = false }: Props) {
    const mergedButtonProps = isRowAction ? { ...rowActionButtonProps('copyId'), ...buttonProps } : buttonProps;
    return (
        <CopyButton
            value={id}
            label="item ID"
            testId={testId}
            copiedMessage={`Copied: ${id}`}
            {...(mergedButtonProps ? { buttonProps: mergedButtonProps } : {})}
            {...(isRowAction ? { shortcutKey: ROW_ACTION_KEYS.copyId } : {})}
        />
    );
}
