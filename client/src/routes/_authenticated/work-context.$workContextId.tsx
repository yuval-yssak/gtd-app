import { createFileRoute } from '@tanstack/react-router';
import { DetailNotFound } from '../../components/DetailNotFound';
import { DetailPageHeader } from '../../components/DetailPageHeader';
import { ListSkeleton } from '../../components/ListSkeleton';
import { WorkContextEditorBody } from '../../components/workContexts/WorkContextEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
import { Card } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useScrollToTopOnMount } from '../../hooks/useListScrollRestoration';
import { useNavigateBack } from '../../hooks/useNavigateBack';
import { usePageEscapeToClose } from '../../hooks/usePageEscapeToClose';
import styles from './-work-context.$workContextId.module.css';

export const Route = createFileRoute('/_authenticated/work-context/$workContextId')({
    component: WorkContextPage,
});

function WorkContextPage() {
    const { db } = Route.useRouteContext();
    const { workContextId } = Route.useParams();
    // Unfiltered allWorkContexts: a deep link must resolve even when the context's owner account
    // is currently toggled out of view (the user navigated here explicitly).
    const { allWorkContexts, isInitialSyncing } = useAppData();
    const historyBackOr = useNavigateBack();
    // The scroll surface keeps the list's offset across the route change — start the form at the top.
    useScrollToTopOnMount();

    const workContext = allWorkContexts.find((c) => c._id === workContextId) ?? null;
    // A blank name falls back to the header's label rather than a bare app name.
    useDocumentTitle(workContext?.name.trim() || 'Edit context');
    const goBack = () => historyBackOr('/work-contexts');

    // The editor body owns no ESC handling (the dialog chrome closes on Escape itself), so the
    // page owns it for both the found and not-found branches.
    usePageEscapeToClose({ enabled: true, onEscape: goBack });

    if (!workContext) {
        // A cold deep link (an MCP-stamped URL in a fresh tab) resolves only after the bootstrap
        // sync lands; show the skeleton, not a false "not found".
        return (
            <div className={styles.page}>
                <DetailPageHeader title="Edit context" onBack={goBack} />
                {isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <DetailNotFound message="Work context not found — it may have been deleted." actionLabel="Back to Work Contexts" onAction={goBack} />
                )}
            </div>
        );
    }

    return (
        <div className={styles.page} data-testid="workContextPageWrapper">
            <DetailPageHeader title="Edit context" onBack={goBack} idForCopy={workContext._id} />
            <Card padding="none" className={styles.card}>
                {/* key: re-seed the form state when navigating between context pages */}
                <WorkContextEditorBody key={workContext._id} db={db} workContext={workContext} chrome="page" onClose={goBack} />
            </Card>
        </div>
    );
}
