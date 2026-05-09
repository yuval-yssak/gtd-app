import Collapse from '@mui/material/Collapse';
import { ItemEditorBody, type ItemEditorBodyProps } from './ItemEditorBody';

type Props = Omit<ItemEditorBodyProps, 'chrome'>;

/**
 * Inline expand variant of the item editor — rendered directly under the clicked row by the host
 * page (via `useItemEditor.renderExpandFor`). Pass `key={item._id}` on the parent so the body
 * remounts when the editor opens on a different item.
 */
export function EditItemExpand(props: Props) {
    return (
        <Collapse in>
            <ItemEditorBody {...props} chrome="expand" />
        </Collapse>
    );
}
