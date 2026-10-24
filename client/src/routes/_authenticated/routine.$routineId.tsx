import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { ArrowRight, CircleCheck } from 'lucide-react';
import { useState, useTransition } from 'react';
import { RoutineEditorBody } from '../../components/routineEditor/RoutineEditorBody';
import { RoutinePageHeader } from '../../components/routineEditor/RoutinePageHeader';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone, FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import { Button, Card, Chip, Text, Toast } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
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
            <Button disabled startIcon={<ArrowRight />} className={styles.nextItemLink} data-testid="routineNextItemEmpty">
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
        <div className={styles.nextItemRow}>
            <Button
                startIcon={<ArrowRight />}
                className={styles.nextItemLink}
                onClick={(e) => navigateOrNewTab(e, { to: '/item/$itemId', params: { itemId: item._id }, search: { status: null } })}
                data-testid="routineNextItemLink"
            >
                Next: {item.title}
                {dateLabel && ` · ${dateLabel}`}
            </Button>
            {isOverdue && <Chip label="Overdue" tone="warning" size="sm" data-testid="routineNextItemOverdueChip" />}
            <Button
                size="sm"
                startIcon={<CircleCheck />}
                disabled={isCompleting}
                onClick={onMarkDone}
                className={styles.nextItemDone}
                data-testid="routineNextItemMarkDone"
            >
                Mark done
            </Button>
            <Toast open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} />
        </div>
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
    // A blank title falls back to the header's label rather than a bare app name.
    useDocumentTitle(routine?.title.trim() || 'Edit routine');
    const goBack = () => historyBackOr('/routines');

    // ESC on the not-found branch, where RoutineEditorBody (which owns the editor's ESC
    // handling) never mounts — mirrors its "Go back" button. Enabled only then, so exactly one
    // listener is active at a time. Declared before the early return to keep hook order stable.
    usePageEscapeToClose({ enabled: !routine || !account, onEscape: goBack });

    if (!routine || !account) {
        return (
            <div className={styles.page} data-testid="routinePageWrapper">
                <RoutinePageHeader title="Edit routine" onBack={goBack} />
                <div className={styles.notFound}>
                    <Text tone="secondary">Routine not found — it may have been deleted.</Text>
                    <Button onClick={goBack}>Go back</Button>
                </div>
            </div>
        );
    }

    async function onSaved() {
        await refreshRoutines();
        await refreshItems();
    }

    return (
        <div className={styles.page} data-testid="routinePageWrapper">
            <RoutinePageHeader title="Edit routine" onBack={goBack} idForCopy={routine._id} />
            <NextItemLink routine={routine} items={allItems} />
            <Card padding="none" className={styles.card}>
                <RoutineEditorBody
                    key={routine._id}
                    db={db}
                    userId={account.id}
                    workContexts={allWorkContexts}
                    people={allPeople}
                    routine={routine}
                    onClose={goBack}
                    onSaved={onSaved}
                />
            </Card>
        </div>
    );
}
