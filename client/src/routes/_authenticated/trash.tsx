import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { ArchivedItemsView } from '../../components/ArchivedItemsView';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';

export const Route = createFileRoute('/_authenticated/trash')({
    validateSearch: parseListQuerySearch,
    component: TrashPage,
});

function TrashPage() {
    useDocumentTitle('Trash');
    const { q } = Route.useSearch();
    const navigate = useNavigate();
    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/trash', search: { q: query || undefined }, replace: true }), [navigate]);
    return (
        <ArchivedItemsView
            status="trash"
            title="Trash"
            emptyIcon={<Trash2 aria-hidden="true" />}
            emptyMessage="Trashed items will appear here. They are kept so you can review what was discarded."
            urlQuery={q ?? ''}
            writeUrlQuery={writeUrlQuery}
        />
    );
}
