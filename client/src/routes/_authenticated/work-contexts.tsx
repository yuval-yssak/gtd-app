import { createFileRoute } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountPicker } from '../../components/AccountPicker';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { ListEmptyMessage } from '../../components/ListEmptyMessage';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSkeleton } from '../../components/ListSkeleton';
import { ListRow, ListRowText } from '../../components/listRow/ListRow';
import { RowActionButton } from '../../components/RowActionButton';
import { WorkContextEditDialog } from '../../components/workContexts/WorkContextEditDialog';
import { useAppData } from '../../contexts/AppDataProvider';
import { createWorkContext, removeWorkContext, updateWorkContext } from '../../db/workContextMutations';
import { Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, TextField, Tooltip } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { SHORTCUT_ROW_PROPS } from '../../lib/rowShortcuts';
import type { StoredWorkContext } from '../../types/MyDB';
import styles from './-work-contexts.module.css';

export const Route = createFileRoute('/_authenticated/work-contexts')({
    component: WorkContextsPage,
});

function WorkContextsPage() {
    useDocumentTitle('Work Contexts');
    const { db } = Route.useRouteContext();
    const { account, workContexts, refreshWorkContexts, loggedInAccounts, isInitialSyncing } = useAppData();
    const [createOpen, setCreateOpen] = useState(false);
    // Renames autosave inside WorkContextEditDialog (mount-on-open); creation stays an explicit
    // Add action so half-typed names never become synced entities.
    const [editing, setEditing] = useState<StoredWorkContext | null>(null);
    const [nameInput, setNameInput] = useState('');
    const [ownerUserId, setOwnerUserId] = useState<string>('');

    function openCreate() {
        setNameInput('');
        setOwnerUserId(account?.id ?? '');
        setCreateOpen(true);
    }

    async function onCreate() {
        if (!account || !nameInput.trim()) {
            return;
        }
        await createWorkContext(db, { userId: ownerUserId || account.id, name: nameInput.trim() });
        setCreateOpen(false);
        await refreshWorkContexts();
    }

    async function onDelete(ctx: StoredWorkContext) {
        await removeWorkContext(db, ctx._id);
        await refreshWorkContexts();
    }

    // Archive = soft retire: hidden from pickers/filter rows, existing item references stay intact.
    // Unarchive drops the key entirely (exactOptionalPropertyTypes/op-schema style: absent ⇒ active).
    // Re-read from IDB before writing — the render-time row can be stale against a concurrent
    // remote update, and the full LWW snapshot would revert it (e.g. undo a remote rename).
    async function onToggleArchived(ctx: StoredWorkContext) {
        const current = (await db.get('workContexts', ctx._id)) ?? ctx;
        const { archived: _archived, ...active } = current;
        await updateWorkContext(db, current.archived ? active : { ...current, archived: true });
        await refreshWorkContexts();
    }

    // Active contexts first, archived parked at the bottom. The "Unused" hint marks archive
    // candidates: nothing outside the trash references them.
    const usage = useEntityUsage();
    const orderedContexts = useMemo(() => [...workContexts.filter((c) => !c.archived), ...workContexts.filter((c) => c.archived)], [workContexts]);

    function renderContextRow(ctx: StoredWorkContext, isDivided: boolean) {
        return (
            <ListRow
                {...SHORTCUT_ROW_PROPS}
                isDivided={isDivided}
                actions={
                    <>
                        <RowActionButton
                            rowAction="edit"
                            label="Rename"
                            icon={<Pencil />}
                            onClick={() => setEditing(ctx)}
                            data-testid="workContextRowEditButton"
                        />
                        <Tooltip title={ctx.archived ? 'Unarchive' : 'Archive — hide from pickers, keep on items'}>
                            <IconButton
                                size="sm"
                                aria-label={ctx.archived ? 'Unarchive' : 'Archive'}
                                onClick={() => void onToggleArchived(ctx)}
                                data-testid="workContextRowArchiveButton"
                            >
                                {ctx.archived ? <ArchiveRestore /> : <Archive />}
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                            <IconButton size="sm" tone="danger" aria-label="Delete" onClick={() => void onDelete(ctx)}>
                                <Trash2 />
                            </IconButton>
                        </Tooltip>
                    </>
                }
            >
                {/* Not a button: a context row has nothing to open — rename lives in the row actions. */}
                <div className={styles.rowBody}>
                    <ListRowText
                        primary={
                            <span className={styles.primary} data-archived={ctx.archived || undefined}>
                                <span>{ctx.name}</span>
                                <AccountChip userId={ctx.userId} />
                                {ctx.archived && <Chip label="Archived" variant="outline" data-testid="workContextArchivedChip" />}
                                {/* A native title, matching the people page's row (see the comment there). */}
                                {!ctx.archived && !usage.contexts.has(ctx._id) && (
                                    <span title="No item references this context — consider archiving it">
                                        <Chip label="Unused" variant="outline" tone="warning" data-testid="workContextUnusedChip" />
                                    </span>
                                )}
                            </span>
                        }
                    />
                </div>
            </ListRow>
        );
    }

    return (
        <div>
            <ListPageHeader
                title="Work Contexts"
                count={workContexts.length}
                action={
                    <Button startIcon={<Plus />} variant="solid" size="sm" onClick={openCreate}>
                        Add context
                    </Button>
                }
            >
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
            </ListPageHeader>
            {workContexts.length === 0 ? (
                // First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <ListEmptyMessage>No work contexts yet. Examples: @office, @phone, @computer, @errands.</ListEmptyMessage>
                )
            ) : (
                <ul className={styles.list}>
                    {orderedContexts.map((ctx, idx) => (
                        <li key={ctx._id}>{renderContextRow(ctx, idx < orderedContexts.length - 1)}</li>
                    ))}
                </ul>
            )}
            {editing && <WorkContextEditDialog db={db} workContext={editing} onClose={() => setEditing(null)} />}
            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} size="xs" fullWidth>
                <DialogTitle>Add work context</DialogTitle>
                <DialogContent className={styles.createContent}>
                    <TextField
                        label="Name"
                        placeholder="e.g. @office, @phone"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        fullWidth
                        autoFocus
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void onCreate();
                        }}
                    />
                    {/* Auto-hides on single-account devices */}
                    {loggedInAccounts.length > 1 && <AccountPicker value={ownerUserId} onChange={setOwnerUserId} />}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button onClick={() => void onCreate()} variant="solid" disabled={!nameInput.trim()}>
                        Add
                    </Button>
                </DialogActions>
            </Dialog>
        </div>
    );
}
