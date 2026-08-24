import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useCallback, useState } from 'react';
import { usePendingReassign } from '../contexts/PendingReassignProvider';
import { FROM_GMAIL_READONLY_MESSAGE } from '../db/itemMutations';
import type { MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import { type ItemEditorActionsApi, ItemEditorBody, type ItemEditorChrome } from './itemEditor/ItemEditorBody';
import styles from './ProcessInboxWizard.module.css';

interface ProcessInboxWizardProps {
    items: StoredItem[];
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onItemProcessed: () => Promise<void>;
    /** Render chrome — dialog (default) wraps in MUI Dialog; page mounts inline for the /process-inbox route. */
    chrome?: 'dialog' | 'page';
}

export type WizardStep = { kind: 'item'; index: number; itemId: string; isLast: boolean } | { kind: 'done' };

/**
 * Pure progression — what step is the wizard on, given a list of items and a current index?
 * Extracted so the index/done transition can be tested without rendering the body.
 */
export function nextWizardStep(items: ReadonlyArray<StoredItem>, index: number): WizardStep {
    if (index >= items.length) {
        return { kind: 'done' };
    }
    const current = items[index];
    if (!current) {
        return { kind: 'done' };
    }
    return { kind: 'item', index, itemId: current._id, isLast: index + 1 >= items.length };
}

/** Maps a clarify-mode setting to the chrome the batch wizard should render. */
export function batchChromeFor(mode: string): 'dialog' | 'page' {
    return mode === 'page' ? 'page' : 'dialog';
}

/**
 * Sequential wizard over inbox items. Hosts the universal ItemEditorBody for the current item so
 * each item gets the full status-chip / forms / cross-account picker — same UX as single-item
 * editing on every other list page. Wraps the body in a Dialog or inline page container; the
 * "Save & next" / "Skip" actions advance to the next item via a body remount on the index change.
 */
export function ProcessInboxWizard({ items, db, people, workContexts, onClose, onItemProcessed, chrome = 'dialog' }: ProcessInboxWizardProps) {
    const [index, setIndex] = useState(0);
    const step = nextWizardStep(items, index);
    const { isPending } = usePendingReassign();
    // Local snackbar slot for the fromGmail-read-only warning — wizard doesn't use useItemEditor.
    const [toast, setToast] = useState<{ open: boolean; message: string }>({ open: false, message: '' });

    const advance = useCallback(() => {
        setIndex((i) => i + 1);
    }, []);

    // ItemEditorBody schedules `onSaved()` then `onClose()` once a save commits. By passing
    // refresh+advance as the close handler, "Save & next" is the body's normal save path with
    // the wizard's progression piggy-backed on top — no parallel save logic to maintain.
    //
    // IMPORTANT: cross-account reassigns inside the body are fire-and-forget — `onClose()` runs
    // synchronously and `onSaved()` is chained off the post-flight promise. The wizard advances
    // before the move resolves; the PendingReassignProvider overlay covers the visual gap.
    const onSavedItem = useCallback(async () => {
        await onItemProcessed();
    }, [onItemProcessed]);

    const onCloseItem = useCallback(() => {
        advance();
    }, [advance]);

    const closeToast = () => setToast((s) => ({ ...s, open: false }));
    const toastSnackbar = <Snackbar open={toast.open} autoHideDuration={3000} onClose={closeToast} message={toast.message} />;

    if (step.kind === 'done') {
        const total = items.length;
        // Wrap the done-view in a fragment so a fromGmail snackbar from the just-saved last item
        // remains visible after the wizard switches off the editor branch.
        return (
            <>
                {chrome === 'dialog' ? <DoneDialog total={total} onClose={onClose} /> : <DonePage total={total} onClose={onClose} />}
                {toastSnackbar}
            </>
        );
    }

    const currentItem = items[step.index];
    if (!currentItem) {
        // nextWizardStep already guarantees this, but TS needs the narrowing.
        return null;
    }
    const reassignInFlight = isPending('item', currentItem._id);

    const renderActions = (api: ItemEditorActionsApi) => <WizardActions isLast={step.isLast} api={api} onSkip={advance} onAbort={onClose} />;

    // When the current item is mid-reassign the body refuses to render the editor (it would
    // misroute writes under the target user). The wizard must still surface Skip so the user
    // can move past the in-flight item — otherwise the only available gesture is Cancel,
    // which loses all wizard progression.
    const inFlightContent = reassignInFlight ? <ReassignInFlightWizardBody isLast={step.isLast} onSkip={advance} onAbort={onClose} /> : null;

    const editorBody = (bodyChrome: ItemEditorChrome) => (
        <ItemEditorBody
            key={`${currentItem._id}:${step.index}`}
            item={currentItem}
            db={db}
            people={people}
            workContexts={workContexts}
            onClose={onCloseItem}
            onSaved={onSavedItem}
            onFromGmailReadOnly={() => setToast({ open: true, message: FROM_GMAIL_READONLY_MESSAGE })}
            renderActions={renderActions}
            chrome={bodyChrome}
        />
    );

    if (chrome === 'page') {
        return (
            <>
                <Box className={styles.pageRoot}>
                    <WizardHeader index={step.index} total={items.length} chrome="page" />
                    <Box className={styles.pageBody}>{inFlightContent ?? editorBody('page')}</Box>
                </Box>
                {toastSnackbar}
            </>
        );
    }

    return (
        <>
            <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
                <DialogTitle className={styles.dialogTitle}>
                    <WizardHeader index={step.index} total={items.length} chrome="dialog" />
                </DialogTitle>
                <DialogContent dividers>{inFlightContent ?? editorBody('dialog')}</DialogContent>
            </Dialog>
            {toastSnackbar}
        </>
    );
}

interface WizardHeaderProps {
    index: number;
    total: number;
    chrome: 'dialog' | 'page';
}

function WizardHeader({ index, total, chrome }: WizardHeaderProps) {
    const titleVariant = chrome === 'page' ? 'h6' : 'subtitle1';
    return (
        <Box className={styles.headerRow}>
            <Box className={styles.headerTextBlock}>
                {/* component="span" prevents an h6 nested inside DialogTitle's h2, which is invalid HTML */}
                <Typography
                    component="span"
                    variant={titleVariant}
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    Process Inbox
                </Typography>
                <Typography
                    component="span"
                    variant="caption"
                    sx={{
                        color: 'text.secondary',
                    }}
                >
                    {index + 1} of {total}
                </Typography>
            </Box>
            {/* No header CopyIdButton here: the wizard passes no `hasHostCopyIdButton`, so
                ItemEditorBody's meta row renders the copy button for this host. */}
        </Box>
    );
}

interface WizardActionsProps {
    isLast: boolean;
    api: ItemEditorActionsApi;
    onSkip: () => void;
    onAbort: () => void;
}

function WizardActions({ isLast, api, onSkip, onAbort }: WizardActionsProps) {
    const saveLabel = isLast ? 'Save & finish' : 'Save & next';
    return (
        <>
            <Button onClick={onAbort} color="inherit" disabled={api.isSaving} data-testid="processInboxExit">
                Exit
            </Button>
            <Button onClick={onSkip} color="inherit" disabled={api.isSaving} data-testid="processInboxSkip">
                Skip{isLast ? ' & finish' : ' for now'}
            </Button>
            <Button variant="contained" disabled={api.saveDisabled} onClick={api.triggerSave} data-testid="processInboxSaveNext">
                {saveLabel}
            </Button>
        </>
    );
}

interface ReassignInFlightWizardBodyProps {
    isLast: boolean;
    onSkip: () => void;
    onAbort: () => void;
}

/** In-flight branch — the body would seed ownerUserId from the overlayed (target) user, so the
 *  wizard refuses the edit but keeps Skip / Exit reachable so the user isn't trapped. */
function ReassignInFlightWizardBody({ isLast, onSkip, onAbort }: ReassignInFlightWizardBodyProps) {
    return (
        <Box className={styles.inFlightBody}>
            <Alert severity="info" variant="outlined">
                This item is being moved to another account. You can edit it once the move completes — skip past it for now.
            </Alert>
            <Box className={styles.inFlightActions}>
                <Button onClick={onAbort} color="inherit" data-testid="processInboxExit">
                    Exit
                </Button>
                <Button onClick={onSkip} variant="contained" data-testid="processInboxSkip">
                    Skip{isLast ? ' & finish' : ' for now'}
                </Button>
            </Box>
        </Box>
    );
}

function DoneDialog({ total, onClose }: { total: number; onClose: () => void }) {
    return (
        <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
            <DialogContent className={styles.completedContent}>
                <AssignmentTurnedInIcon className={styles.completedIcon} />
                <Typography
                    variant="h6"
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    Inbox clear!
                </Typography>
                {total > 0 && (
                    <Typography
                        variant="body2"
                        sx={{
                            color: 'text.secondary',
                            mt: 1,
                        }}
                    >
                        All {total} item{total !== 1 ? 's' : ''} processed.
                    </Typography>
                )}
            </DialogContent>
            <DialogActions className={styles.completedActions}>
                <Button variant="contained" onClick={onClose} data-testid="processInboxDone">
                    Done
                </Button>
            </DialogActions>
        </Dialog>
    );
}

function DonePage({ total, onClose }: { total: number; onClose: () => void }) {
    return (
        <Box className={styles.donePage}>
            <AssignmentTurnedInIcon className={styles.completedIcon} />
            <Typography
                variant="h5"
                sx={{
                    fontWeight: 600,
                }}
            >
                Inbox clear!
            </Typography>
            {total > 0 && (
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                        mt: 1,
                    }}
                >
                    All {total} item{total !== 1 ? 's' : ''} processed.
                </Typography>
            )}
            <Button variant="contained" onClick={onClose} sx={{ mt: 3 }} data-testid="processInboxDone">
                Done
            </Button>
        </Box>
    );
}
