import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { AccountApiError, deleteMyAccount, downloadMyData, SESSION_MISMATCH_CODE } from '#api/accountApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { evaporateUserAndRecoverGated } from '../../db/evaporateUser';
import { APP_NAME } from '../../lib/appName';
import styles from '../../routes/_authenticated/-settings.module.css';
import type { MyDB, StoredAccount } from '../../types/MyDB';
import { describeError, isDeleteConfirmationValid, runAccountDeletion, SESSION_MISMATCH_MESSAGE } from './accountDataSectionLogic';

interface Props {
    db: IDBPDatabase<MyDB>;
    account: StoredAccount | null;
}

export function AccountDataSection({ db, account }: Props) {
    const { withActiveAccountSession } = useAppData();
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const [isDownloading, setIsDownloading] = useState(false);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    async function onDownloadClicked() {
        if (!account) {
            return;
        }
        setDownloadError(null);
        setIsDownloading(true);
        try {
            // Pinned to the active account: the export must be THIS account's, even if the cookie drifted.
            await withActiveAccountSession(() => downloadMyData(account.id));
        } catch (err) {
            const isMismatch = err instanceof AccountApiError && err.code === SESSION_MISMATCH_CODE;
            setDownloadError(isMismatch ? SESSION_MISMATCH_MESSAGE : describeError(err, "Couldn't prepare your export. Please try again."));
        } finally {
            setIsDownloading(false);
        }
    }

    return (
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
                    Your data
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                    Download a copy of everything {APP_NAME} stores for this account as a JSON file, or delete the account and all of its data.
                </Typography>
                <Button variant="outlined" size="small" onClick={onDownloadClicked} disabled={isDownloading || !account} data-testid="downloadMyDataButton">
                    {isDownloading ? 'Preparing…' : 'Download my data'}
                </Button>
                {downloadError && (
                    <Typography variant="body2" color="error" sx={{ mt: 1 }} data-testid="downloadMyDataError">
                        {downloadError}
                    </Typography>
                )}
                <Divider className={styles.divider} />
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
                    Deleting your account removes your items, routines, people, calendar connections, devices and API tokens from our servers immediately and
                    permanently. Other accounts signed in on this device are not affected.
                </Typography>
                <Button
                    variant="outlined"
                    color="error"
                    size="small"
                    onClick={() => setIsDeleteDialogOpen(true)}
                    disabled={!account}
                    data-testid="deleteAccountButton"
                >
                    Delete my account
                </Button>
                {account && <DeleteAccountDialog db={db} account={account} open={isDeleteDialogOpen} onClose={() => setIsDeleteDialogOpen(false)} />}
            </Box>
        </Paper>
    );
}

interface DeleteAccountDialogProps {
    db: IDBPDatabase<MyDB>;
    account: StoredAccount;
    open: boolean;
    onClose: () => void;
}

function DeleteAccountDialog({ db, account, open, onClose }: DeleteAccountDialogProps) {
    const { withActiveAccountSession } = useAppData();
    const [typedEmail, setTypedEmail] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const canConfirm = isDeleteConfirmationValid(typedEmail, account.email) && !isDeleting;

    function onCancel() {
        if (isDeleting) {
            return;
        }
        setTypedEmail('');
        setDeleteError(null);
        onClose();
    }

    async function onConfirm() {
        setDeleteError(null);
        setIsDeleting(true);
        const result = await runAccountDeletion({
            account,
            deleteMyAccount,
            withActiveAccountSession,
            evaporate: (userId) => evaporateUserAndRecoverGated(db, userId),
        });
        // On success the evaporation has scheduled a navigation (next account or /login) — the
        // dialog never needs to close itself. Everything else surfaces inline and re-enables the form.
        if (result.kind !== 'deleted') {
            setDeleteError(result.message);
            setIsDeleting(false);
        }
    }

    return (
        <Dialog open={open} onClose={onCancel} data-testid="deleteAccountDialog" fullWidth maxWidth="xs">
            <DialogTitle>Delete this account?</DialogTitle>
            <DialogContent>
                <DialogContentText sx={{ mb: 2 }}>
                    This permanently deletes <strong>{account.email}</strong> and everything in it, right now. There is no undo and no backup — download your
                    data first if you want to keep a copy.
                </DialogContentText>
                <DialogContentText sx={{ mb: 1 }}>Type the account email to confirm.</DialogContentText>
                <TextField
                    autoFocus
                    fullWidth
                    size="small"
                    type="email"
                    autoComplete="off"
                    placeholder={account.email}
                    value={typedEmail}
                    onChange={(e) => setTypedEmail(e.target.value)}
                    disabled={isDeleting}
                    data-testid="deleteAccountEmailInput"
                />
                {deleteError && (
                    <Typography variant="body2" color="error" sx={{ mt: 1 }} data-testid="deleteAccountError">
                        {deleteError}
                    </Typography>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel} disabled={isDeleting} data-testid="cancelDeleteAccountButton">
                    Cancel
                </Button>
                <Button onClick={onConfirm} color="error" variant="contained" disabled={!canConfirm} data-testid="confirmDeleteAccountButton">
                    {isDeleting ? 'Deleting…' : 'Delete account'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
