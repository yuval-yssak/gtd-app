import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { RoutineEditorBody } from '../../components/routineEditor/RoutineEditorBody';
import { RoutinePageHeader } from '../../components/routineEditor/RoutinePageHeader';
import { useAppData } from '../../contexts/AppDataProvider';
import { Card } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useScrollToTopOnMount } from '../../hooks/useListScrollRestoration';
import { useNavigateBack } from '../../hooks/useNavigateBack';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './-routine.new.module.css';

export const Route = createFileRoute('/_authenticated/routine/new')({
    component: NewRoutinePage,
});

function NewRoutinePage() {
    useDocumentTitle('New routine');
    const { db } = Route.useRouteContext();
    // Unfiltered all* pools: the body scopes them to the owner account itself, and the owner can be
    // switched to an account currently toggled out of view.
    const { account, allWorkContexts, allPeople, refreshRoutines, refreshItems } = useAppData();
    const navigate = useNavigate();
    const historyBackOr = useNavigateBack();
    // The scroll surface keeps the list's offset across the route change — start the form at the top.
    useScrollToTopOnMount();

    const goBack = () => historyBackOr('/routines');
    // Replace, not push: Back from the new routine's page returns to where creation started, never
    // to a blank create form.
    const onCreated = (routine: StoredRoutine) => void navigate({ to: '/routine/$routineId', params: { routineId: routine._id }, replace: true });

    async function onSaved() {
        await refreshRoutines();
        await refreshItems();
    }

    return (
        <div className={styles.page} data-testid="newRoutinePage">
            <RoutinePageHeader title="New routine" onBack={goBack} />
            {/* No active account yet means no owner to create the routine under. */}
            {account && (
                <Card className={styles.card}>
                    <RoutineEditorBody
                        db={db}
                        userId={account.id}
                        workContexts={allWorkContexts}
                        people={allPeople}
                        onClose={goBack}
                        onSaved={onSaved}
                        onCreated={onCreated}
                    />
                </Card>
            )}
        </div>
    );
}
