import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { createFileRoute } from '@tanstack/react-router';
import { ArchivedItemsView } from '../../components/ArchivedItemsView';

export const Route = createFileRoute('/_authenticated/trash')({
    component: TrashPage,
});

function TrashPage() {
    return (
        <ArchivedItemsView
            status="trash"
            title="Trash"
            emptyIcon={<DeleteOutlineIcon />}
            emptyMessage="Trashed items will appear here. They are kept so you can review what was discarded."
        />
    );
}
