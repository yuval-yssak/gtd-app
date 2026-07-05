import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { EditableStatus } from '../../components/editItemDialogLogic';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { ItemEditorBody } from '../../components/itemEditor/ItemEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
import { FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import { useScrollToTopOnMount } from '../../hooks/useListScrollRestoration';
import { useNavigateBack } from '../../hooks/useNavigateBack';
import { usePageEscapeToClose } from '../../hooks/usePageEscapeToClose';
import type { StoredItem } from '../../types/MyDB';
import styles from './-item.$itemId.module.css';

const EDITABLE_STATUSES = new Set<EditableStatus>(['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash']);

function isEditableStatus(value: unknown): value is EditableStatus {
    return typeof value === 'string' && EDITABLE_STATUSES.has(value as EditableStatus);
}

export const Route = createFileRoute('/_authenticated/item/$itemId')({
    // `status` is the canonical pre-selected chip param. `dest` is accepted as a backward-compat
    // alias for one release — older inbox links and history entries still pass it.
    validateSearch: (search): { status: EditableStatus | null } => {
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
        const raw = search['status'] ?? search['dest'];
        return { status: isEditableStatus(raw) ? raw : null };
    },
    component: ItemPage,
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
 * Picks the route to navigate back to after edit/cancel. Always uses the item's render-time
 * status — the user expects to return to the bucket they came from, not the post-save destination.
 */
function backRouteForStatus(status: StoredItem['status']): string {
    if (status === 'nextAction') return '/next-actions';
    if (status === 'calendar') return '/calendar';
    if (status === 'waitingFor') return '/waiting-for';
    if (status === 'somedayMaybe') return '/someday';
    if (status === 'done') return '/done';
    if (status === 'trash') return '/trash';
    return '/inbox';
}

function ItemPage() {
    const { db } = Route.useRouteContext();
    const { itemId } = Route.useParams();
    const { status: initialStatus } = Route.useSearch();
    const { items, workContexts, people, refreshItems } = useAppData();
    const historyBackOr = useNavigateBack();
    // The scroll surface keeps the list's offset across the route change — start the form at the top.
    useScrollToTopOnMount();

    const item = items.find((i) => i._id === itemId) ?? null;

    // Page mode doesn't use useItemEditor, so we own a tiny local snackbar slot to surface the
    // fromGmail-read-only warning when the body's done-transition save fires the callback.
    // Declared before the not-found early return so the hook order stays stable across renders.
    const [toast, setToast] = useState<{ open: boolean; message: string }>({ open: false, message: '' });
    // Set inside `onFromGmailReadOnly` so the post-save navigation in `goBack` can defer the
    // route-change long enough for the user to actually read the snackbar before the page tears
    // down. Without this, the Snackbar's `open` state is set ~1 tick before navigate unmounts the
    // route — the toast never paints.
    const fromGmailJustFiredRef = useRef(false);
    // Tracks the deferred-navigation timer so unmount and re-entry can cancel it (see goBack +
    // the cleanup effect below). Without cancellation, the timer fires into a stale `navigate`
    // closure after the user has already left the page (or stacks with a second goBack click).
    const deferredNavigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (deferredNavigateTimerRef.current !== null) {
                clearTimeout(deferredNavigateTimerRef.current);
                deferredNavigateTimerRef.current = null;
            }
        },
        [],
    );

    // ESC on the not-found branch, where ItemEditorBody (which owns the page-chrome ESC handling)
    // never mounts — mirrors its "Go back" button. Enabled only then, so exactly one listener is
    // active at a time. Declared before the early return to keep hook order stable.
    usePageEscapeToClose({ enabled: !item, onEscape: () => window.history.back() });

    if (!item) {
        return (
            <Box className={styles.page}>
                <PageHeader title="Edit item" onBack={() => window.history.back()} />
                <Typography
                    sx={{
                        color: 'text.secondary',
                        mt: 4,
                        textAlign: 'center',
                    }}
                >
                    Item not found — it may have already been processed.
                </Typography>
                <Button onClick={() => window.history.back()} sx={{ mt: 2, display: 'block', mx: 'auto' }}>
                    Go back
                </Button>
            </Box>
        );
    }

    const navigateBack = () => historyBackOr(backRouteForStatus(item.status));

    const goBack = () => {
        // Cancel any pending deferred navigation so a double-tap Back doesn't stack two navigates
        // and so a normal-path goBack after a fromGmail save doesn't fire alongside the deferred one.
        if (deferredNavigateTimerRef.current !== null) {
            clearTimeout(deferredNavigateTimerRef.current);
            deferredNavigateTimerRef.current = null;
        }
        if (fromGmailJustFiredRef.current) {
            // Defer just long enough for the user to read the snackbar before the route unmounts.
            // Matches the Snackbar's autoHideDuration so the toast finishes its visible cycle on
            // this page, not after the unrelated destination route has mounted. Cleanup effect
            // above cancels the timer on unmount; double-tap is guarded by the clear at the top
            // of this function.
            fromGmailJustFiredRef.current = false;
            deferredNavigateTimerRef.current = setTimeout(() => {
                deferredNavigateTimerRef.current = null;
                navigateBack();
            }, 3000);
            return;
        }
        navigateBack();
    };

    const onFromGmailReadOnly = () => {
        fromGmailJustFiredRef.current = true;
        setToast({ open: true, message: FROM_GMAIL_READONLY_MESSAGE });
    };

    return (
        <Box className={styles.page} data-testid="itemPageWrapper">
            <PageHeader title="Edit item" onBack={goBack} idForCopy={item._id} />
            <Paper variant="outlined" className={styles.card}>
                <ItemEditorBody
                    key={item._id}
                    item={item}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={goBack}
                    onSaved={refreshItems}
                    onFromGmailReadOnly={onFromGmailReadOnly}
                    chrome="page"
                    {...(initialStatus ? { initialStatus } : {})}
                />
            </Paper>
            <Snackbar open={toast.open} autoHideDuration={3000} onClose={() => setToast((s) => ({ ...s, open: false }))} message={toast.message} />
        </Box>
    );
}
