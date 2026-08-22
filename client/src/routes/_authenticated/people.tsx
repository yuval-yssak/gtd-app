import AddIcon from '@mui/icons-material/Add';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountPicker } from '../../components/AccountPicker';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { PersonEditDialog } from '../../components/people/PersonEditDialog';
import { useAppData } from '../../contexts/AppDataProvider';
import { createPerson, removePerson, updatePerson } from '../../db/personMutations';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';
import { useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import { orderPeople } from '../../lib/peopleList';
import type { StoredPerson } from '../../types/MyDB';
import styles from './-people.module.css';

export const Route = createFileRoute('/_authenticated/people')({
    validateSearch: parseListQuerySearch,
    component: PeoplePage,
});

interface CreateFormState {
    name: string;
    email: string;
    phone: string;
    notes: string;
}

const emptyForm: CreateFormState = { name: '', email: '', phone: '', notes: '' };

/** First line of the (markdown) notes, for the row snippet — full notes live in the edit dialog. */
function notesFirstLine(notes: string | undefined): string | null {
    const firstLine = notes
        ?.split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    return firstLine ?? null;
}

/** Row second line: "email · phone" plus a one-line notes snippet. undefined when both are empty
 *  so ListItemText skips the secondary slot entirely (no empty element). */
function personRowSecondary(person: StoredPerson) {
    const contact = [person.email, person.phone].filter(Boolean).join(' · ');
    const snippet = notesFirstLine(person.notes);
    if (!contact && !snippet) {
        return undefined;
    }
    return (
        <>
            {contact || null}
            {snippet && (
                <span className={styles.notesSnippet} data-testid="personNotesSnippet">
                    {snippet}
                </span>
            )}
        </>
    );
}

function PeoplePage() {
    const { db } = Route.useRouteContext();
    const { q } = Route.useSearch();
    const navigate = useNavigate();
    const navigateOrNewTab = useNewTabAwareNavigate();
    useListScrollRestoration();
    const { account, people, refreshPeople, loggedInAccounts, isInitialSyncing } = useAppData();
    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/people', search: { q: query || undefined }, replace: true }), [navigate]);
    const search = useListSearch({ urlQuery: q ?? '', writeUrlQuery });
    const [createOpen, setCreateOpen] = useState(false);
    const [editing, setEditing] = useState<StoredPerson | null>(null);
    const [createForm, setCreateForm] = useState<CreateFormState>(emptyForm);
    // Owner of the entity for create flow. Edit flow lives inside PersonEditorBody (which has its own picker).
    const [createOwnerUserId, setCreateOwnerUserId] = useState<string>('');

    function openCreate() {
        setCreateForm(emptyForm);
        setCreateOwnerUserId(account?.id ?? '');
        setCreateOpen(true);
    }

    async function saveCreate() {
        if (!account || !createForm.name.trim()) return;
        const ownerForCreate = createOwnerUserId || account.id;
        await createPerson(db, {
            userId: ownerForCreate,
            name: createForm.name.trim(),
            ...(createForm.email.trim() ? { email: createForm.email.trim() } : {}),
            ...(createForm.phone.trim() ? { phone: createForm.phone.trim() } : {}),
            ...(createForm.notes.trim() ? { notes: createForm.notes.trim() } : {}),
        });
        setCreateOpen(false);
        await refreshPeople();
    }

    async function onDelete(person: StoredPerson) {
        await removePerson(db, person._id);
        await refreshPeople();
    }

    // Archive = soft retire: hidden from pickers/filter rows, existing item references stay intact.
    // Unarchive drops the key entirely (absent ⇒ active, matching the op-schema convention).
    // Re-read from IDB before writing — the render-time row can be stale against a concurrent
    // remote update, and the full LWW snapshot would revert it (e.g. undo a remote rename).
    async function onToggleArchived(person: StoredPerson) {
        const current = (await db.get('people', person._id)) ?? person;
        const { archived: _archived, ...active } = current;
        await updatePerson(db, current.archived ? active : { ...current, archived: true });
        await refreshPeople();
    }

    // Alphabetical with archived parked at the bottom, filtered by the in-page search (deferred
    // query so typing re-filters in an interruptible background render — see useListSearch).
    // The "Unused" hint marks archive candidates: nothing outside the trash references them.
    const usage = useEntityUsage();
    const { deferredQuery } = search;
    const orderedPeople = useMemo(() => orderPeople(people, deferredQuery), [people, deferredQuery]);

    return (
        <Box>
            <Box className={styles.pageHeader}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        People
                        {people.length > 0 && <Chip label={people.length} size="small" className={styles.countChip} />}
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                    {people.length > 0 && <ListSearchButton onToggle={search.toggleSearch} testId="peopleSearchButton" />}
                </Box>
                <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={openCreate}>
                    Add person
                </Button>
            </Box>
            {people.length > 0 && search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder="Search people…"
                    testId="peopleSearchInput"
                />
            )}
            {people.length === 0 ? (
                // First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Typography
                        sx={{
                            color: 'text.secondary',
                            textAlign: 'center',
                            mt: 6,
                        }}
                    >
                        No people yet. Add contacts to reference in Waiting For and items.
                    </Typography>
                )
            ) : orderedPeople.length === 0 ? (
                <Typography
                    sx={{
                        color: 'text.secondary',
                        textAlign: 'center',
                        mt: 6,
                    }}
                    data-testid="peopleSearchEmpty"
                >
                    No people match your search.
                </Typography>
            ) : (
                <List disablePadding className={styles.list}>
                    {orderedPeople.map((person, idx) => (
                        // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration)
                        <Box key={person._id} data-list-item-id={person._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box className={styles.actionButtons}>
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => setEditing(person)} data-testid="personRowEditButton">
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title={person.archived ? 'Unarchive' : 'Archive — hide from pickers, keep on items'}>
                                            <IconButton size="small" onClick={() => void onToggleArchived(person)} data-testid="personRowArchiveButton">
                                                {person.archived ? <UnarchiveOutlinedIcon fontSize="small" /> : <ArchiveOutlinedIcon fontSize="small" />}
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Delete">
                                            <IconButton size="small" color="error" onClick={() => void onDelete(person)}>
                                                <DeleteOutlineIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                <ListItemText
                                    // Row body opens the full /person page (deep-linkable, matching the other
                                    // list pages); the pencil in secondaryAction keeps the quick edit dialog.
                                    onClick={(e) => navigateOrNewTab(e, { to: '/person/$personId', params: { personId: person._id } })}
                                    data-testid="personRowText"
                                    primary={
                                        <Box
                                            sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                                            className={person.archived ? styles.archivedName : undefined}
                                        >
                                            <span>{person.name}</span>
                                            <AccountChip userId={person.userId} />
                                            {person.archived && <Chip label="Archived" size="small" variant="outlined" data-testid="personArchivedChip" />}
                                            {!person.archived && !usage.people.has(person._id) && (
                                                <Tooltip title="No item references this person — consider archiving them">
                                                    <Chip label="Unused" size="small" variant="outlined" color="warning" data-testid="personUnusedChip" />
                                                </Tooltip>
                                            )}
                                        </Box>
                                    }
                                    secondary={personRowSecondary(person)}
                                    className={styles.listItemText}
                                />
                            </ListItem>
                            {idx < orderedPeople.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
            {/* Edit dialog reuses the shared PersonEditDialog component (also used by MeetingDetails).
                Mount-on-open so the form re-initializes per person — see PersonEditDialog comment. */}
            {editing && <PersonEditDialog db={db} person={editing} showAccountPicker onClose={() => setEditing(null)} />}
            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle>Add person</DialogTitle>
                <DialogContent>
                    <Box className={styles.personForm}>
                        <TextField
                            label="Name"
                            value={createForm.name}
                            onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                            fullWidth
                            autoFocus
                            required
                        />
                        <TextField
                            label="Email"
                            value={createForm.email}
                            onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                            fullWidth
                            type="email"
                        />
                        <TextField label="Phone" value={createForm.phone} onChange={(e) => setCreateForm((f) => ({ ...f, phone: e.target.value }))} fullWidth />
                        <TextField
                            label="Notes"
                            value={createForm.notes}
                            onChange={(e) => setCreateForm((f) => ({ ...f, notes: e.target.value }))}
                            fullWidth
                            multiline
                            minRows={2}
                            helperText="Markdown supported"
                            data-testid="personCreateNotes"
                        />
                        {/* AccountPicker auto-hides on single-account devices */}
                        {loggedInAccounts.length > 1 && <AccountPicker value={createOwnerUserId} onChange={setCreateOwnerUserId} />}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button onClick={() => void saveCreate()} variant="contained" disabled={!createForm.name.trim()}>
                        Add
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
