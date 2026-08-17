import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { ListSkeleton } from '../../components/ListSkeleton';
import { PersonEditorBody } from '../../components/people/PersonEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
import { useScrollToTopOnMount } from '../../hooks/useListScrollRestoration';
import { useNavigateBack } from '../../hooks/useNavigateBack';
import { usePageEscapeToClose } from '../../hooks/usePageEscapeToClose';
import styles from './-person.$personId.module.css';

export const Route = createFileRoute('/_authenticated/person/$personId')({
    component: PersonPage,
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

function PersonNotFound({ onBack }: { onBack: () => void }) {
    return (
        <>
            <Typography
                sx={{
                    color: 'text.secondary',
                    mt: 4,
                    textAlign: 'center',
                }}
            >
                Person not found — they may have been deleted.
            </Typography>
            {/* Not "Go back" — that's the header arrow's accessible name; a duplicate name
                breaks strict a11y queries and reads redundantly to screen readers. */}
            <Button onClick={onBack} sx={{ mt: 2, display: 'block', mx: 'auto' }}>
                Back to People
            </Button>
        </>
    );
}

function PersonPage() {
    const { db } = Route.useRouteContext();
    const { personId } = Route.useParams();
    // Unfiltered allPeople: a deep link must resolve even when the person's owner account is
    // currently toggled out of view (the user navigated here explicitly).
    const { allPeople, isInitialSyncing } = useAppData();
    const historyBackOr = useNavigateBack();
    // The scroll surface keeps the list's offset across the route change — start the form at the top.
    useScrollToTopOnMount();

    const person = allPeople.find((p) => p._id === personId) ?? null;
    const goBack = () => historyBackOr('/people');

    // The person editor body owns no ESC handling (dialog chrome gets it from MUI Modal), so the
    // page owns it for both the found and not-found branches.
    usePageEscapeToClose({ enabled: true, onEscape: goBack });

    if (!person) {
        // A cold deep link (the headline use case — an MCP-stamped URL in a fresh tab) resolves
        // only after the bootstrap sync lands; show the skeleton, not a false "not found".
        return (
            <Box className={styles.page}>
                <PageHeader title="Edit person" onBack={goBack} />
                {isInitialSyncing ? <ListSkeleton /> : <PersonNotFound onBack={goBack} />}
            </Box>
        );
    }

    return (
        <Box className={styles.page} data-testid="personPageWrapper">
            <PageHeader title="Edit person" onBack={goBack} idForCopy={person._id} />
            <Paper variant="outlined" className={styles.card}>
                {/* key: re-seed the form state when navigating between person pages */}
                <PersonEditorBody key={person._id} db={db} person={person} showAccountPicker chrome="page" onClose={goBack} />
            </Paper>
        </Box>
    );
}
