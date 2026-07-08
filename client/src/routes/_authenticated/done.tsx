import DoneAllIcon from '@mui/icons-material/DoneAll';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { ArchivedItemsView } from '../../components/ArchivedItemsView';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';

export const Route = createFileRoute('/_authenticated/done')({
    validateSearch: parseListQuerySearch,
    component: DonePage,
});

function DonePage() {
    const { q } = Route.useSearch();
    const navigate = useNavigate();
    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/done', search: { q: query || undefined }, replace: true }), [navigate]);
    return (
        <ArchivedItemsView
            status="done"
            title="Done"
            emptyIcon={<DoneAllIcon />}
            emptyMessage="Completed items will appear here once you finish your first task."
            urlQuery={q ?? ''}
            writeUrlQuery={writeUrlQuery}
        />
    );
}
