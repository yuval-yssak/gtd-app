import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { ArrowRight, Calendar, EllipsisVertical, Hourglass, ListChecks, NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type ReactNode, type TouchEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import type { EditableStatus } from '../../components/editItemDialogLogic';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { ListRow, ListRowButton, ListRowText } from '../../components/listRow/ListRow';
import { MarkdownNotesEditor, NOTES_PLACEHOLDER } from '../../components/markdown/MarkdownNotesEditor';
import { MarkdownPreview } from '../../components/markdown/MarkdownPreview';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { RankedListChrome } from '../../components/rankedList/RankedListChrome';
import { RankedRowHandle } from '../../components/rankedList/RankedRowHandle';
import { type ItemRow, rankedRowButtonProps, rankedRowProps } from '../../components/rankedList/rankedRowProps';
import { useAppData } from '../../contexts/AppDataProvider';
import { deleteInboxCaptureDraft, getInboxCaptureDraft, saveInboxCaptureDraft } from '../../db/draftHelpers';
import { clarifyToDone, clarifyToTrash, collectItem } from '../../db/itemMutations';
import { Button, Card, Chip, Drawer, IconButton, Tabs, Text, TextField, Toast, Tooltip } from '../../designSystem';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { useAutosave } from '../../hooks/useAutosave';
import { useCaptureNotesPanel } from '../../hooks/useCaptureNotesPanel';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useHiddenAccountCaptureNotice } from '../../hooks/useHiddenAccountCaptureNotice';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { type RankedListApi, useRankedList } from '../../hooks/useRankedList';
import { useSwipeGesture } from '../../hooks/useSwipeGesture';
import { inboxItemsInOrder } from '../../lib/inboxOrder';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';
import { flatSection, itemRows } from '../../lib/nextActionSections';
import { ROW_HANDLE_ATTR } from '../../lib/nextActionsRowDom';
import { ownerIdsOfStatus } from '../../lib/rankSections';
import { RANKED_LIST_ROW_ACTIONS } from '../../lib/rowShortcuts';
import type { StoredItem } from '../../types/MyDB';
import styles from './-inbox.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_authenticated/inbox')({
    validateSearch: parseListQuerySearch,
    component: InboxPage,
});

const NOTES_TABS = [
    { value: 0, label: 'Edit' },
    { value: 1, label: 'Preview' },
] as const;

// --- Mobile swipe row ---

/** The reorder handle's touch gesture stays its own: a touch that starts on it must not also swipe the row. */
const startsOnHandle = (e: TouchEvent) => e.target instanceof Element && e.target.closest(`[${ROW_HANDLE_ATTR}]`) !== null;

/** Wraps a swipe handler so it ignores touches that began on the reorder handle. */
function unlessOnHandle(handler: (e: TouchEvent) => void) {
    return (e: TouchEvent) => {
        if (!startsOnHandle(e)) handler(e);
    };
}

interface InboxSwipeItemProps {
    item: StoredItem;
    // exactOptionalPropertyTypes requires explicit `| undefined` to allow passing `.find()?.title`
    routineTitle?: string | undefined;
    onTap: (item: StoredItem) => void;
    onMore: (item: StoredItem) => void;
    onSwipeNextAction: (item: StoredItem) => void;
    onSwipeTrash: (item: StoredItem) => void;
    /** Long-press drag reorder: the shared ranked-list wiring and this row's place in it. */
    ranked: RankedListApi;
    row: ItemRow;
    isGhost: boolean;
}

function InboxSwipeItem({ item, routineTitle, onTap, onMore, onSwipeNextAction, onSwipeTrash, ranked, row, isGhost }: InboxSwipeItemProps) {
    const { touchHandlers, translateX, wasDragRef } = useSwipeGesture({
        onSwipeRight: () => onSwipeNextAction(item),
        onSwipeLeft: () => onSwipeTrash(item),
    });

    function onActivated() {
        // wasDragRef is a ref (not state), so it always holds the current value when
        // the click fires synchronously after touchEnd — no stale-closure risk.
        if (wasDragRef.current) return;
        onTap(item);
    }
    const showRight = translateX > 0;
    const showLeft = translateX < 0;

    return (
        // The ranked-row props go on the wrapper: the drag moves and shifts the whole row (reveal panes included).
        <div {...rankedRowProps(ranked, row, styles.swipeWrapper)}>
            {showRight && (
                <div className={styles.revealRight}>
                    <ArrowRight size={20} />
                    <Text as="span" variant="bodySm" tone="inherit">
                        Next Action
                    </Text>
                </div>
            )}
            {showLeft && (
                <div className={styles.revealLeft}>
                    <Text as="span" variant="bodySm" tone="inherit">
                        Trash
                    </Text>
                    <Trash2 size={20} />
                </div>
            )}
            <ListRow
                className={styles.swipeItem}
                data-testid="inboxSwipeRow"
                // The finger's live offset — measured geometry, so an inline value.
                style={{ transform: `translateX(${translateX}px)`, transition: translateX === 0 ? 'transform 0.2s ease' : 'none' }}
                onTouchStart={unlessOnHandle(touchHandlers.onTouchStart)}
                onTouchMove={unlessOnHandle(touchHandlers.onTouchMove)}
                onTouchEnd={unlessOnHandle(touchHandlers.onTouchEnd)}
                onTouchCancel={unlessOnHandle(touchHandlers.onTouchCancel)}
                actions={
                    <Tooltip title="More actions">
                        <IconButton size="sm" aria-label="More actions" onClick={() => onMore(item)} data-testid="inboxItemMoreButton">
                            <EllipsisVertical />
                        </IconButton>
                    </Tooltip>
                }
            >
                {/* Long press drags (as on every ranked list); its touches never swipe the row. A ghost is not a drag source. */}
                {!isGhost && <RankedRowHandle ranked={ranked} item={item} section={row.section} testId="inboxDragHandle" />}
                <ListRowButton onActivate={onActivated} className={styles.swipeBody}>
                    <ListRowText
                        primary={
                            <>
                                <span>{item.title}</span>
                                {item.routineId && <RoutineIndicator routineId={item.routineId} routineTitle={routineTitle} />}
                                <AccountChip userId={item.userId} />
                            </>
                        }
                        secondary={dayjs(item.createdTs).fromNow()}
                    />
                </ListRowButton>
            </ListRow>
        </div>
    );
}

// --- Mobile bottom sheet ---

interface InboxBottomSheetProps {
    item: StoredItem | null;
    onClose: () => void;
    onEdit: (item: StoredItem) => void;
    onDone: (item: StoredItem) => void;
    onNextAction: (item: StoredItem) => void;
    onCalendar: (item: StoredItem) => void;
    onWaitingFor: (item: StoredItem) => void;
    onTrash: (item: StoredItem) => void;
    /** Opens the "Move to…" sheet — the touch way to change the item's place in the inbox. */
    onMoveTo: (item: StoredItem) => void;
}

function InboxBottomSheet({ item, onClose, onEdit, onDone, onNextAction, onCalendar, onWaitingFor, onTrash, onMoveTo }: InboxBottomSheetProps) {
    if (!item) {
        return null;
    }

    const resolvedItem = item;

    function action(fn: (i: StoredItem) => void) {
        fn(resolvedItem);
        onClose();
    }

    return (
        // The title names the sheet (Base UI wires it as the dialog's label).
        <Drawer side="bottom" open={Boolean(item)} onClose={onClose} title={item.title}>
            <ul className={styles.sheetActions}>
                <SheetAction icon={<Pencil />} label="Edit" onSelected={() => action(onEdit)} />
                <SheetAction icon={<EllipsisVertical />} label="Move to…" onSelected={() => action(onMoveTo)} testId="inboxSheetMoveTo" />
                <SheetAction icon={<ListChecks />} label="Done (< 2 min)" onSelected={() => action(onDone)} />
                <SheetAction icon={<ArrowRight />} label="Next Action" onSelected={() => action(onNextAction)} />
                <SheetAction icon={<Calendar />} label="Calendar" onSelected={() => action(onCalendar)} />
                <SheetAction icon={<Hourglass />} label="Waiting For" onSelected={() => action(onWaitingFor)} />
                <SheetAction icon={<Trash2 />} label="Trash" onSelected={() => action(onTrash)} isDestructive />
            </ul>
        </Drawer>
    );
}

interface SheetActionProps {
    icon: ReactNode;
    label: string;
    onSelected: () => void;
    isDestructive?: boolean | undefined;
    testId?: string | undefined;
}

function SheetAction({ icon, label, onSelected, isDestructive = false, testId }: SheetActionProps) {
    return (
        <li>
            <button type="button" className={styles.sheetAction} data-destructive={isDestructive || undefined} onClick={onSelected} data-testid={testId}>
                <span className={styles.sheetActionIcon} aria-hidden="true">
                    {icon}
                </span>
                {label}
            </button>
        </li>
    );
}

// --- Page ---

function InboxPage() {
    useDocumentTitle('Inbox');
    const { db } = Route.useRouteContext();
    const { q } = Route.useSearch();
    const { account, items, routines, refreshItems, isInitialSyncing } = useAppData();
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const captureFieldRef = useAutoFocus();

    const editor = useItemEditor();

    const [draft, setDraft] = useState('');
    const [notes, setNotes] = useState('');
    const notesPanel = useCaptureNotesPanel();
    // Shared "captured into a hidden account" snackbar — same surface the quick-capture FAB uses.
    const { noticeCaptureIfHidden, hiddenAccountNotice } = useHiddenAccountCaptureNotice();

    // Capture-field draft persistence: half-typed title/notes survive reloads and navigation.
    // Debounce is short — writes are local-only (drafts never sync), so eager persistence is cheap.
    const draftAutosave = useAutosave<{ title: string; notes: string }>({
        initial: { title: '', notes: '' },
        delayMs: 300,
        commit: async (value) => {
            if (account) {
                await saveInboxCaptureDraft(db, account.id, value);
            }
        },
    });

    // Restore a persisted draft once on mount. isDirty() means the user already started typing
    // before the IDB read resolved — their live input wins over the stored leftover.
    useEffect(() => {
        if (!account) {
            return;
        }
        let cancelled = false;
        void getInboxCaptureDraft(db, account.id).then((stored) => {
            if (cancelled || !stored || draftAutosave.isDirty()) {
                return;
            }
            setDraft(stored.title);
            setNotes(stored.notes);
            if (stored.notes) {
                notesPanel.openForRestoredDraft();
            }
            // Re-baseline so restoring doesn't immediately rewrite the same draft row.
            draftAutosave.reset({ title: stored.title, notes: stored.notes });
        });
        return () => {
            cancelled = true;
        };
        // draftAutosave and the notes-panel actions are stable; account/db are boot-stable.
    }, [account, db, draftAutosave, notesPanel.openForRestoredDraft]);

    function onCaptureFieldsChange(nextTitle: string, nextNotes: string) {
        setDraft(nextTitle);
        setNotes(nextNotes);
        draftAutosave.onChange({ title: nextTitle, notes: nextNotes });
    }

    // Mobile bottom sheet — reachable via the per-row "more" button. Tap on the row body now
    // opens the unified editor instead.
    const [bottomSheetItem, setBottomSheetItem] = useState<StoredItem | null>(null);

    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);

    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/inbox', search: { q: query || undefined }, replace: true }), [navigate]);
    const search = useListSearch({ urlQuery: q ?? '', writeUrlQuery });

    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;
    // The manual order (`rank`; a capture is minted at the top, so untouched it stays newest-first).
    const inboxItems = useMemo(() => inboxItemsInOrder(itemsWithGhosts, deferredQuery), [itemsWithGhosts, deferredQuery]);
    // One section, no header: the whole inbox is one manual order (see lib/rankSections).
    const inboxSections = useMemo(() => [flatSection('inbox', 'Inbox', inboxItems)], [inboxItems]);
    // Every account of the merged inbox (visible rows or not) shares the keyspace a re-key must see.
    const inboxOwnerIds = useMemo(() => ownerIdsOfStatus(items, 'inbox'), [items]);
    const ranked = useRankedList({ db, sections: inboxSections, isGhost, ownerIds: inboxOwnerIds, refreshItems, hasHeaders: false, regionLabel: 'Inbox' });
    const [inboxSection] = inboxSections;

    // Lookup map so each row doesn't rescan the routines array for its indicator title.
    const routineTitleById = useMemo(() => new Map(routines.map((r) => [r._id, r.title])), [routines]);

    // Ghosts are fading leftovers of items just clarified away — counts and the batch wizard use live rows only.
    const liveInboxItems = inboxItems.filter((item) => !isGhost(item));

    async function onCapture() {
        const title = draft.trim();
        if (!title || !account) {
            return;
        }
        setDraft('');
        setNotes('');
        notesPanel.resetAfterCapture();
        // The text is committed as a real item — drop the draft row and re-baseline the autosave
        // so a pending debounce tick can't resurrect the just-captured text. reset() drops the
        // scheduled timer; flush() then drains any commit already in flight before the delete.
        draftAutosave.reset({ title: '', notes: '' });
        await draftAutosave.flush();
        await deleteInboxCaptureDraft(db, account.id);
        await collectItem(db, account.id, { title, notes });
        await refreshItems();
        noticeCaptureIfHidden(account.id);
    }

    async function onKeyDown(e: KeyboardEvent) {
        if (e.key === 'Enter') await onCapture();
    }

    // Both take focus on to the next row once the row leaves (a keyboard user must not be left on its ghost).
    async function onQuickDone(item: StoredItem) {
        const handOff = ranked.focusHandOffFrom(item._id);
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
        handOff();
    }

    async function onTrash(item: StoredItem) {
        const handOff = ranked.focusHandOffFrom(item._id);
        await clarifyToTrash(db, item);
        await refreshItems();
        handOff();
    }

    function openWithStatus(item: StoredItem, status: EditableStatus, clickEvent?: MouseEvent<HTMLElement>) {
        editor.openEditor({ item, initialStatus: status, event: clickEvent });
    }

    // Deliberate: with an in-page search active, the wizard batches only the matching items (the
    // page re-applies the same query) — "process what I searched for".
    function startProcessInbox() {
        if (liveInboxItems.length === 0) {
            return;
        }
        void navigate({ to: '/process-inbox', search: { q: deferredQuery.trim() || undefined } });
    }

    return (
        <div>
            <div className={styles.pageHeader}>
                {/* Title + sync chip grouped so the chip stays beside the title; pageHeader's space-between keeps the button right. */}
                <div className={styles.titleGroup}>
                    <Text variant="title">
                        Inbox
                        {liveInboxItems.length > 0 && <Chip label={liveInboxItems.length} tone="accent" className={styles.countChip} />}
                    </Text>
                    <AccountSyncChip />
                    <ListSearchButton onToggle={search.toggleSearch} testId="inboxSearchButton" />
                </div>
                <Button variant="outline" size="sm" disabled={liveInboxItems.length === 0} onClick={startProcessInbox} data-testid="processInboxButton">
                    Process Inbox ({liveInboxItems.length})
                </Button>
            </div>
            {search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder="Search inbox…"
                    testId="inboxSearchInput"
                />
            )}
            <div className={styles.capture}>
                <TextField
                    fullWidth
                    placeholder="What's on your mind?"
                    aria-label="Capture to inbox"
                    value={draft}
                    onChange={(e) => onCaptureFieldsChange(e.target.value, notes)}
                    onKeyDown={onKeyDown}
                    inputRef={captureFieldRef}
                    endAdornment={
                        <>
                            <Tooltip title={notesPanel.isOpen ? 'Hide note' : 'Add note'}>
                                {/* Accent while the note has content, so the user knows a note is attached. */}
                                <IconButton
                                    aria-label={notesPanel.isOpen ? 'Hide note' : 'Add note'}
                                    tone={notes.trim() ? 'accent' : 'neutral'}
                                    onClick={notesPanel.toggleByUser}
                                    data-testid="inboxAddNoteButton"
                                >
                                    <NotebookPen />
                                </IconButton>
                            </Tooltip>
                            <IconButton aria-label="Capture" onClick={() => void onCapture()} disabled={!draft.trim()} edge="end">
                                <Plus />
                            </IconButton>
                        </>
                    }
                />
                {notesPanel.isOpen && (
                    <Card padding="none" className={styles.captureNotes}>
                        <Tabs value={notesPanel.tab} onValueChange={notesPanel.selectTab} tabs={NOTES_TABS} aria-label="Note" className={styles.tabs} />
                        {notesPanel.tab === 0 ? (
                            <MarkdownNotesEditor
                                value={notes}
                                onValueChange={(next) => onCaptureFieldsChange(draft, next)}
                                placeholder={NOTES_PLACEHOLDER}
                                autoFocus={notesPanel.shouldFocusEditor}
                            />
                        ) : (
                            <div className={styles.notesPreview}>
                                {notes.trim() ? <MarkdownPreview markdown={notes} /> : <span className={styles.notesEmpty}>Nothing to preview.</span>}
                            </div>
                        )}
                    </Card>
                )}
            </div>
            {inboxItems.length === 0 ? (
                // Skeleton during first-launch bootstrap; the "inbox zero" copy is only truthful once loaded.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Text tone="secondary" className={styles.emptyMessage}>
                        {/* An active search that matches nothing is "no results", not inbox zero. */}
                        {deferredQuery.trim() ? 'No inbox items match your search.' : 'Inbox zero — well done.'}
                    </Text>
                )
            ) : (
                // Windowed rendering — only rows near the viewport mount, so a large inbox doesn't block
                // the main thread on navigation; virtua renders the <ul>/<li> itself. The named section
                // is the list's one tab stop on desktop (see useNextActionsRovingFocus); phones use the
                // swipe rows, each with a long-press reorder handle.
                <section
                    className={styles.list}
                    aria-label="Inbox"
                    // The reorder key hint describes keyboard reordering, which phones (swipe rows) do not have.
                    {...(isMobile ? {} : { 'aria-describedby': ranked.hintIds.list })}
                    data-testid="inboxList"
                    {...(isMobile ? {} : ranked.roving.listProps)}
                >
                    <WindowVirtualizer ref={ranked.virtualizerRef} as="ul" item="li">
                        {itemRows(ranked.flatRows).map((row) => {
                            const { item, section, isLastInSection } = row;
                            return (
                                <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                                    {isMobile ? (
                                        <div className={styles.mobileRow} data-divided={!isLastInSection || undefined}>
                                            <InboxSwipeItem
                                                item={item}
                                                routineTitle={item.routineId ? routineTitleById.get(item.routineId) : undefined}
                                                onTap={(i) => editor.openEditor({ item: i })}
                                                onMore={setBottomSheetItem}
                                                onSwipeNextAction={(i) => editor.openEditor({ item: i, initialStatus: 'nextAction' })}
                                                onSwipeTrash={(i) => void onTrash(i)}
                                                ranked={ranked}
                                                row={row}
                                                isGhost={isGhost(item)}
                                            />
                                        </div>
                                    ) : (
                                        <ListRow
                                            {...rankedRowProps(ranked, row)}
                                            isDivided={!isLastInSection}
                                            actions={
                                                <>
                                                    {/* Everything but Copy id is hidden on a ghost: pressing Done or Trash on its stale snapshot (even by keyboard) would act twice. */}
                                                    {!isGhost(item) && (
                                                        <RowActionButton
                                                            rowAction="moveTo"
                                                            label="Move to…"
                                                            icon={<EllipsisVertical />}
                                                            onClick={() => ranked.openMoveTo(item, section)}
                                                            data-testid="inboxItemMoveToButton"
                                                            {...ranked.roving.actionButtonProps}
                                                        />
                                                    )}
                                                    <CopyIdButton
                                                        isRowAction
                                                        id={item._id}
                                                        testId="inboxItemCopyIdButton"
                                                        buttonProps={ranked.roving.actionButtonProps}
                                                    />
                                                    {!isGhost(item) && (
                                                        <>
                                                            <RowActionButton
                                                                rowAction="edit"
                                                                label="Edit"
                                                                icon={<Pencil />}
                                                                onClick={(e) => editor.openEditor({ item, event: e })}
                                                                data-testid="inboxItemEditButton"
                                                                {...ranked.roving.actionButtonProps}
                                                            />
                                                            <QuickActionButton
                                                                label="Done (< 2 min)"
                                                                icon={<ListChecks />}
                                                                onClick={() => void onQuickDone(item)}
                                                                buttonProps={ranked.roving.actionButtonProps}
                                                            />
                                                            <QuickActionButton
                                                                label="Next Action"
                                                                icon={<ArrowRight />}
                                                                onClick={(e) => openWithStatus(item, 'nextAction', e)}
                                                                buttonProps={ranked.roving.actionButtonProps}
                                                            />
                                                            <QuickActionButton
                                                                label="Calendar"
                                                                icon={<Calendar />}
                                                                onClick={(e) => openWithStatus(item, 'calendar', e)}
                                                                buttonProps={ranked.roving.actionButtonProps}
                                                            />
                                                            <QuickActionButton
                                                                label="Waiting For"
                                                                icon={<Hourglass />}
                                                                onClick={(e) => openWithStatus(item, 'waitingFor', e)}
                                                                buttonProps={ranked.roving.actionButtonProps}
                                                            />
                                                            <QuickActionButton
                                                                label="Trash"
                                                                icon={<Trash2 />}
                                                                tone="danger"
                                                                onClick={() => void onTrash(item)}
                                                                buttonProps={ranked.roving.actionButtonProps}
                                                            />
                                                        </>
                                                    )}
                                                </>
                                            }
                                        >
                                            {!isGhost(item) && <RankedRowHandle ranked={ranked} item={item} section={section} testId="inboxDragHandle" />}
                                            <ListRowButton
                                                onActivate={(e) => editor.openEditor({ item, event: e })}
                                                {...rankedRowButtonProps(ranked)}
                                                data-testid="inboxItemRow"
                                            >
                                                <ListRowText
                                                    primary={
                                                        <>
                                                            <span>{item.title}</span>
                                                            {item.routineId && (
                                                                <RoutineIndicator
                                                                    routineId={item.routineId}
                                                                    routineTitle={routineTitleById.get(item.routineId)}
                                                                />
                                                            )}
                                                            <AccountChip userId={item.userId} />
                                                        </>
                                                    }
                                                    secondary={dayjs(item.createdTs).fromNow()}
                                                />
                                            </ListRowButton>
                                        </ListRow>
                                    )}
                                </ListRowShell>
                            );
                        })}
                    </WindowVirtualizer>
                </section>
            )}

            <Toast open={editor.toast.open} autoHideDuration={3000} onClose={editor.closeToast} message={editor.toast.message} />
            {hiddenAccountNotice}

            {/* Keyboard hints, the reorder announcer, the failure toast and the Move to sheet. */}
            <RankedListChrome ranked={ranked} actions={RANKED_LIST_ROW_ACTIONS} sectionNoun="list" liveTestId="inboxReorderLive" />

            <InboxBottomSheet
                item={bottomSheetItem}
                onMoveTo={(i) => {
                    if (inboxSection) {
                        ranked.openMoveTo(i, inboxSection);
                    }
                }}
                onClose={() => setBottomSheetItem(null)}
                onEdit={(i) => editor.openEditor({ item: i })}
                onDone={(i) => void onQuickDone(i)}
                onNextAction={(i) => editor.openEditor({ item: i, initialStatus: 'nextAction' })}
                onCalendar={(i) => editor.openEditor({ item: i, initialStatus: 'calendar' })}
                onWaitingFor={(i) => editor.openEditor({ item: i, initialStatus: 'waitingFor' })}
                onTrash={(i) => void onTrash(i)}
            />
        </div>
    );
}

interface QuickActionButtonProps {
    label: string;
    icon: ReactNode;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    tone?: 'danger' | undefined;
    /** The list's roving wiring: out of the tab order, walked by the row's arrows. */
    buttonProps: RankedListApi['roving']['actionButtonProps'];
}

/** One of the desktop row's clarify shortcuts: an icon button named and hinted by its label. */
function QuickActionButton({ label, icon, onClick, tone, buttonProps }: QuickActionButtonProps) {
    return (
        <Tooltip title={label}>
            <IconButton size="sm" aria-label={label} tone={tone} onClick={onClick} {...buttonProps}>
                {icon}
            </IconButton>
        </Tooltip>
    );
}
