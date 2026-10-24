import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ProcessInboxWizard } from '../../components/ProcessInboxWizard';
import { useAppData } from '../../contexts/AppDataProvider';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { inboxItemsInOrder } from '../../lib/inboxOrder';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';
import type { StoredItem } from '../../types/MyDB';

export const Route = createFileRoute('/_authenticated/process-inbox')({
    // `q` carries the inbox search the run was started from, so only the matching items are walked.
    validateSearch: parseListQuerySearch,
    component: ProcessInboxPage,
});

/**
 * The batch wizard, reached from the inbox's "Process Inbox" button: Skip / Save & next over each
 * inbox item, ending on "Inbox clear".
 *
 * Inbox items are snapshotted once on mount (`useMemo([])`) so saves that move an item out of
 * the inbox don't shrink the source array mid-walk and skew the index.
 */
function ProcessInboxPage() {
    useDocumentTitle('Process Inbox');
    const { db } = Route.useRouteContext();
    const { q } = Route.useSearch();
    const { items, people, workContexts, refreshItems } = useAppData();
    const navigate = useNavigate();

    // Snapshot inbox items once at mount — saves that move items out of the inbox shrink the live
    // `items` array, which would skew the wizard's index. useState lazy initialiser holds the
    // snapshot stable across re-renders without the lint-trap that comes from `useMemo([])`.
    const [inboxSnapshot] = useState<StoredItem[]>(() => inboxItemsInOrder(items, q ?? ''));

    // Back to the inbox with the search the run started from still applied.
    const close = () => void navigate({ to: '/inbox', search: { q } });

    if (inboxSnapshot.length === 0) {
        return (
            <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography
                    sx={{
                        color: 'text.secondary',
                        mb: 2,
                    }}
                >
                    Inbox zero — nothing to process.
                </Typography>
                <Button variant="contained" onClick={close}>
                    Back to Inbox
                </Button>
            </Box>
        );
    }

    return <ProcessInboxWizard items={inboxSnapshot} db={db} people={people} workContexts={workContexts} onClose={close} onItemProcessed={refreshItems} />;
}
