import DoneAllIcon from '@mui/icons-material/DoneAll';
import { createFileRoute } from '@tanstack/react-router';
import { ArchivedItemsView } from '../../components/ArchivedItemsView';

export const Route = createFileRoute('/_authenticated/done')({
    component: DonePage,
});

function DonePage() {
    return (
        <ArchivedItemsView
            status="done"
            title="Done"
            emptyIcon={<DoneAllIcon />}
            emptyMessage="Completed items will appear here once you finish your first task."
        />
    );
}
