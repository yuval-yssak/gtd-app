import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { RoutineEditorBody } from '../../components/routineEditor/RoutineEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
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

/** Jump-link to the routine's next generated item; renders disabled with a reason when none exists. */
function NextItemLink({ routine, items }: { routine: StoredRoutine; items: StoredItem[] }) {
    const navigate = useNavigate();
    const result = findRoutineNextItem(routine, items, dayjs());

    if (!result.item) {
        return (
            <Button disabled startIcon={<ArrowForwardIcon />} className={styles.nextItemLink} data-testid="routineNextItemEmpty">
                {result.reason}
            </Button>
        );
    }

    const { item } = result;
    const dateLabel = describeNextItemDate(item);
    return (
        <Button
            startIcon={<ArrowForwardIcon />}
            className={styles.nextItemLink}
            onClick={() => void navigate({ to: '/item/$itemId', params: { itemId: item._id }, search: { status: null } })}
            data-testid="routineNextItemLink"
        >
            Next: {item.title}
            {dateLabel && ` · ${dateLabel}`}
        </Button>
    );
}

function RoutinePage() {
    const { db } = Route.useRouteContext();
    const { routineId } = Route.useParams();
    const { account, routines, items, workContexts, people, refreshRoutines, refreshItems } = useAppData();

    const routine = routines.find((r) => r._id === routineId) ?? null;
    const goBack = () => window.history.back();

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
            <NextItemLink routine={routine} items={items} />
            <Paper variant="outlined" className={styles.card}>
                <RoutineEditorBody
                    key={routine._id}
                    db={db}
                    userId={account.id}
                    workContexts={workContexts}
                    people={people}
                    routine={routine}
                    onClose={goBack}
                    onSaved={onSaved}
                    chrome="page"
                />
            </Paper>
        </Box>
    );
}
