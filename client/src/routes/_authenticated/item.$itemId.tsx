import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { EditableStatus } from '../../components/editItemDialogLogic';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { ItemEditorBody } from '../../components/itemEditor/ItemEditorBody';
import { useAppData } from '../../contexts/AppDataProvider';
import type { StoredItem } from '../../types/MyDB';
import styles from './-item.$itemId.module.css';

const EDITABLE_STATUSES = new Set<EditableStatus>(['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe']);

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
 * Picks the route to navigate back to after edit/cancel. Routes by the item's status at the time
 * of render — the status the user came from is the most polite "back" target. After a save changes
 * the status, the navigate fires before any local re-read, so this is captured at the right moment.
 */
function backRouteForStatus(status: StoredItem['status']): string {
    if (status === 'nextAction') return '/next-actions';
    if (status === 'calendar') return '/calendar';
    if (status === 'waitingFor') return '/waiting-for';
    if (status === 'somedayMaybe') return '/someday';
    return '/inbox';
}

function ItemPage() {
    const { db } = Route.useRouteContext();
    const { itemId } = Route.useParams();
    const { status: initialStatus } = Route.useSearch();
    const { items, workContexts, people, refreshItems } = useAppData();
    const navigate = useNavigate();

    const item = items.find((i) => i._id === itemId) ?? null;

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

    const goBack = () => void navigate({ to: backRouteForStatus(item.status) });

    if (item.status === 'done' || item.status === 'trash') {
        return (
            <Box className={styles.page}>
                <PageHeader title="Item" onBack={goBack} idForCopy={item._id} />
                <Typography
                    sx={{
                        color: 'text.secondary',
                        mt: 4,
                        textAlign: 'center',
                    }}
                >
                    This item has already been processed.
                </Typography>
            </Box>
        );
    }

    // Re-read from IDB so a status-changing save lands the user on the correct destination —
    // the closure-captured `items` array is the pre-save snapshot, not yet refreshed.
    const onClose = async () => {
        const fresh = await db.get('items', itemId);
        void navigate({ to: backRouteForStatus(fresh?.status ?? item.status) });
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
                    onClose={() => void onClose()}
                    onSaved={refreshItems}
                    chrome="page"
                    {...(initialStatus ? { initialStatus } : {})}
                />
            </Paper>
        </Box>
    );
}
