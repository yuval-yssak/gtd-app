import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState, useTransition } from 'react';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { RoutineEditorBody } from '../../components/routineEditor/RoutineEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone, FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import { useScrollToTopOnMount } from '../../hooks/useListScrollRestoration';
import { useNavigateBack } from '../../hooks/useNavigateBack';
import { usePageEscapeToClose } from '../../hooks/usePageEscapeToClose';
import { useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import { describeNextItemDate, findRoutineNextItem } from '../../lib/routineNextItem';
import type { StoredItem, StoredRoutine } from '../../types/MyDB';
import styles from './-routine.$routineId.module.css';

export const Route = createFileRoute('/_authenticated/routine/$routineId')({
    component: RoutinePage,
});

function PageHeader({ title, onBack, idForCopy }: { title: string; onBack: () => void; idForCopy?: string }) {
    return (
        <Box className={styles.header}>
            <IconButton onClick={onBack} size="small" aria-label="Go back">
                <ArrowBackIcon />
            </IconButton>
            <Typography
                variant="h6"
                className={styles.headerTitle}
                sx={{
                    fontWeight: 600,
                }}
            >
                {title}
            </Typography>
            {idForCopy && <CopyIdButton id={idForCopy} />}
        </Box>
    );
}

/**
 * Jump-link to the routine's next generated item, with an inline "Mark done" so the occurrence can
 * be completed without opening it. An occurrence whose time has passed but which is still open is
 * shown as OVERDUE rather than hidden — that is precisely the one the user came here to complete.
 * Renders disabled with a reason only when the routine has generated nothing at all.
 */
function NextItemLink({ routine, items }: { routine: StoredRoutine; items: StoredItem[] }) {
    const { db } = Route.useRouteContext();
    const { refreshItems } = useAppData();
    const navigateOrNewTab = useNewTabAwareNavigate();
    const [isCompleting, startCompleting] = useTransition();
    const [toast, setToast] = useState('');
    const result = findRoutineNextItem(routine, items, dayjs());

    if (!result.item) {
        return (
            <Button disabled startIcon={<ArrowForwardIcon />} className={styles.nextItemLink} data-testid="routineNextItemEmpty">
                {result.reason}
            </Button>
        );
    }

    const { item, isOverdue } = result;
    const dateLabel = describeNextItemDate(item);
    // Completing advances the series (clarifyToDone → maybeCreateNextRoutineItem), so the link
    // re-resolves to the following occurrence on the refresh.
    const onMarkDone = () =>
        startCompleting(async () => {
            await clarifyToDone(db, item, { onReadOnlyGCal: () => setToast(FROM_GMAIL_READONLY_MESSAGE) });
            await refreshItems();
        });

    return (
        <Box className={styles.nextItemRow}>
            <Button
                startIcon={<ArrowForwardIcon />}
                className={styles.nextItemLink}
                onClick={(e) => navigateOrNewTab(e, { to: '/item/$itemId', params: { itemId: item._id }, search: { status: null } })}
                data-testid="routineNextItemLink"
            >
                Next: {item.title}
                {dateLabel && ` · ${dateLabel}`}
            </Button>
            {isOverdue && <Chip label="Overdue" color="warning" size="small" data-testid="routineNextItemOverdueChip" />}
            <Button
                size="small"
                startIcon={<CheckCircleOutlineIcon />}
                disabled={isCompleting}
                onClick={onMarkDone}
                className={styles.nextItemDone}
                data-testid="routineNextItemMarkDone"
            >
                Mark done
            </Button>
            <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} />
        </Box>
    );
}

function RoutinePage() {
    const { db } = Route.useRouteContext();
    const { routineId } = Route.useParams();
    // Unfiltered all* sets: a deep link must resolve even when the routine's owner account is
    // currently toggled out of view (the user navigated here explicitly).
    const { account, allRoutines, allItems, allWorkContexts, allPeople, refreshRoutines, refreshItems } = useAppData();
    const historyBackOr = useNavigateBack();
    // The scroll surface keeps the list's offset across the route change — start the form at the top.
    useScrollToTopOnMount();

    const routine = allRoutines.find((r) => r._id === routineId) ?? null;
    const goBack = () => historyBackOr('/routines');

    // ESC on the not-found branch, where RoutineEditorBody (which owns the page-chrome ESC
    // handling) never mounts — mirrors its "Go back" button. Enabled only then, so exactly one
    // listener is active at a time. Declared before the early return to keep hook order stable.
    usePageEscapeToClose({ enabled: !routine || !account, onEscape: goBack });

    if (!routine || !account) {
        return (
            <Box className={styles.page} data-testid="routinePageWrapper">
                <PageHeader title="Edit routine" onBack={goBack} />
                <Typography
                    sx={{
                        color: 'text.secondary',
                        mt: 4,
                        textAlign: 'center',
                    }}
                >
                    Routine not found — it may have been deleted.
                </Typography>
                <Button onClick={goBack} sx={{ mt: 2, display: 'block', mx: 'auto' }}>
                    Go back
                </Button>
            </Box>
        );
    }

    async function onSaved() {
        await refreshRoutines();
        await refreshItems();
    }

    return (
        <Box className={styles.page} data-testid="routinePageWrapper">
            <PageHeader title="Edit routine" onBack={goBack} idForCopy={routine._id} />
            <NextItemLink routine={routine} items={allItems} />
            <Paper variant="outlined" className={styles.card}>
                <RoutineEditorBody
                    key={routine._id}
                    db={db}
                    userId={account.id}
                    workContexts={allWorkContexts}
                    people={allPeople}
                    routine={routine}
                    onClose={goBack}
                    onSaved={onSaved}
                    chrome="page"
                />
            </Paper>
        </Box>
    );
}
