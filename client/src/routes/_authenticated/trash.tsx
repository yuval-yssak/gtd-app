import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { ArchivedItemsView } from '../../components/ArchivedItemsView';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';

export const Route = createFileRoute('/_authenticated/trash')({
    validateSearch: parseListQuerySearch,
    component: TrashPage,
});

function TrashPage() {
    const { q } = Route.useSearch();
    const navigate = useNavigate();
    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/trash', search: { q: query || undefined }, replace: true }), [navigate]);
    return (
        <ArchivedItemsView
            status="trash"
            title="Trash"
            emptyIcon={<DeleteOutlineIcon />}
            emptyMessage="Trashed items will appear here. They are kept so you can review what was discarded."
            urlQuery={q ?? ''}
            writeUrlQuery={writeUrlQuery}
        />
    );
}
