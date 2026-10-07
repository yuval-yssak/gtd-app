import { CopyButton } from '../CopyButton';

interface Props {
    id: string;
    // Optional override so list-row instances can have distinct selectors while the editor/page
    // headers keep the default `copyItemIdButton` testid that existing tests depend on.
    testId?: string;
}

/** Copy-to-clipboard icon for an entity ID; the success Snackbar echoes the ID so the user sees what was copied. */
export function CopyIdButton({ id, testId = 'copyItemIdButton' }: Props) {
    return <CopyButton value={id} label="item ID" testId={testId} copiedMessage={`Copied: ${id}`} />;
}
