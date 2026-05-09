import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ProcessInboxWizard } from '../../components/ProcessInboxWizard';
import { useAppData } from '../../contexts/AppDataProvider';
import type { StoredItem } from '../../types/MyDB';

export const Route = createFileRoute('/_authenticated/process-inbox')({
    component: ProcessInboxPage,
});

/**
 * Page-mode batch wizard. Reached when the Item-editor setting is "Full Page" and the user clicks
 * "Process Inbox" — keeps the same wizard semantics (Skip / Save & next, terminal "Inbox clear")
 * but mounts the universal ItemEditorBody full-page instead of inside a Dialog.
 *
 * Inbox items are snapshotted once on mount (`useMemo([])`) so saves that move an item out of
 * the inbox don't shrink the source array mid-walk and skew the index.
 */
function ProcessInboxPage() {
    const { db } = Route.useRouteContext();
    const { items, people, workContexts, refreshItems } = useAppData();
    const navigate = useNavigate();

    // Snapshot inbox items once at mount — saves that move items out of the inbox shrink the live
    // `items` array, which would skew the wizard's index. useState lazy initialiser holds the
    // snapshot stable across re-renders without the lint-trap that comes from `useMemo([])`.
    const [inboxSnapshot] = useState<StoredItem[]>(() => items.filter((i) => i.status === 'inbox').sort((a, b) => b.createdTs.localeCompare(a.createdTs)));

    const close = () => void navigate({ to: '/inbox' });

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

    return (
        <ProcessInboxWizard
            items={inboxSnapshot}
            db={db}
            people={people}
            workContexts={workContexts}
            onClose={close}
            onItemProcessed={refreshItems}
            chrome="page"
        />
    );
}
