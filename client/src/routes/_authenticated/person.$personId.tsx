import { createFileRoute } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { ListSkeleton } from '../../components/ListSkeleton';
import { PersonEditorBody } from '../../components/people/PersonEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
import { Button, Card, IconButton, Text } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useScrollToTopOnMount } from '../../hooks/useListScrollRestoration';
import { useNavigateBack } from '../../hooks/useNavigateBack';
import { usePageEscapeToClose } from '../../hooks/usePageEscapeToClose';
import styles from './-person.$personId.module.css';

export const Route = createFileRoute('/_authenticated/person/$personId')({
    component: PersonPage,
});

function PageHeader({ title, onBack, idForCopy }: { title: string; onBack: () => void; idForCopy?: string }) {
    return (
        <div className={styles.header}>
            <IconButton onClick={onBack} size="sm" aria-label="Go back">
                <ArrowLeft />
            </IconButton>
            <Text variant="titleSm" weight="semibold" className={styles.headerTitle}>
                {title}
            </Text>
            {idForCopy && <CopyIdButton id={idForCopy} />}
        </div>
    );
}

function PersonNotFound({ onBack }: { onBack: () => void }) {
    return (
        <div className={styles.notFound}>
            <Text tone="secondary">Person not found — they may have been deleted.</Text>
            {/* Not "Go back" — that's the header arrow's accessible name; a duplicate name
                breaks strict a11y queries and reads redundantly to screen readers. */}
            <Button onClick={onBack}>Back to People</Button>
        </div>
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
    // A blank name falls back to the header's label rather than a bare app name.
    useDocumentTitle(person?.name.trim() || 'Edit person');
    const goBack = () => historyBackOr('/people');

    // The person editor body owns no ESC handling (the dialog chrome closes on Escape itself), so
    // the page owns it for both the found and not-found branches.
    usePageEscapeToClose({ enabled: true, onEscape: goBack });

    if (!person) {
        // A cold deep link (the headline use case — an MCP-stamped URL in a fresh tab) resolves
        // only after the bootstrap sync lands; show the skeleton, not a false "not found".
        return (
            <div className={styles.page}>
                <PageHeader title="Edit person" onBack={goBack} />
                {isInitialSyncing ? <ListSkeleton /> : <PersonNotFound onBack={goBack} />}
            </div>
        );
    }

    return (
        <div className={styles.page} data-testid="personPageWrapper">
            <PageHeader title="Edit person" onBack={goBack} idForCopy={person._id} />
            <Card padding="none" className={styles.card}>
                {/* key: re-seed the form state when navigating between person pages */}
                <PersonEditorBody key={person._id} db={db} person={person} showAccountPicker chrome="page" onClose={goBack} />
            </Card>
        </div>
    );
}
