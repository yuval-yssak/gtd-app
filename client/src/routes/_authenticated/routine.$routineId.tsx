import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { RoutineEditorBody } from '../../components/routineEditor/RoutineEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
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

function RoutinePage() {
    const { db } = Route.useRouteContext();
    const { routineId } = Route.useParams();
    const { account, routines, workContexts, people, refreshRoutines, refreshItems } = useAppData();

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
