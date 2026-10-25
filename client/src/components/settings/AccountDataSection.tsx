import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { AccountApiError, deleteMyAccount, downloadMyData, SESSION_MISMATCH_CODE } from '#api/accountApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { evaporateUserAndRecoverGated } from '../../db/evaporateUser';
import { Button, Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle, Separator, Text, TextField } from '../../designSystem';
import { APP_NAME } from '../../lib/appName';
import type { MyDB, StoredAccount } from '../../types/MyDB';
import sectionStyles from './AccountDataSection.module.css';
import { describeError, isDeleteConfirmationValid, runAccountDeletion, SESSION_MISMATCH_MESSAGE } from './accountDataSectionLogic';
import { SettingsSection } from './SettingsSection';

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
        <SettingsSection
            title="Your data"
            description={`Download a copy of everything ${APP_NAME} stores for this account as a JSON file, or delete the account and all of its data.`}
        >
            <Button variant="outline" size="sm" onClick={onDownloadClicked} disabled={isDownloading || !account} data-testid="downloadMyDataButton">
                {isDownloading ? 'Preparing…' : 'Download my data'}
            </Button>
            {downloadError && (
                <Text variant="bodySm" tone="error" className={sectionStyles.error} data-testid="downloadMyDataError">
                    {downloadError}
                </Text>
            )}
            <Separator className={sectionStyles.divider} />
            <Text variant="bodySm" tone="secondary" className={sectionStyles.deleteIntro}>
                Deleting your account removes your items, routines, people, calendar connections, devices and API tokens from our servers immediately and
                permanently. Other accounts signed in on this device are not affected.
            </Text>
            <Button variant="outline" tone="danger" size="sm" onClick={() => setIsDeleteDialogOpen(true)} disabled={!account} data-testid="deleteAccountButton">
                Delete my account
            </Button>
            {account && <DeleteAccountDialog db={db} account={account} open={isDeleteDialogOpen} onClose={() => setIsDeleteDialogOpen(false)} />}
        </SettingsSection>
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
        // A plain Dialog, not AlertDialog: the typed-email field takes focus (the confirmation gate),
        // and the destructive button stays disabled until it matches.
        <Dialog open={open} onClose={onCancel} data-testid="deleteAccountDialog" fullWidth size="xs">
            <DialogTitle>Delete this account?</DialogTitle>
            <DialogContent>
                <DialogDescription className={sectionStyles.dialogParagraph}>
                    This permanently deletes <strong>{account.email}</strong> and everything in it, right now. There is no undo and no backup — download your
                    data first if you want to keep a copy.
                </DialogDescription>
                <Text variant="bodySm" tone="secondary" className={sectionStyles.dialogPrompt}>
                    Type the account email to confirm.
                </Text>
                <TextField
                    autoFocus
                    fullWidth
                    size="sm"
                    type="email"
                    autoComplete="off"
                    placeholder={account.email}
                    value={typedEmail}
                    onChange={(e) => setTypedEmail(e.target.value)}
                    disabled={isDeleting}
                    inputProps={{ 'aria-label': 'Account email' }}
                    data-testid="deleteAccountEmailInput"
                />
                {deleteError && (
                    <Text variant="bodySm" tone="error" className={sectionStyles.error} data-testid="deleteAccountError">
                        {deleteError}
                    </Text>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel} disabled={isDeleting} data-testid="cancelDeleteAccountButton">
                    Cancel
                </Button>
                <Button onClick={onConfirm} tone="danger" variant="solid" disabled={!canConfirm} data-testid="confirmDeleteAccountButton">
                    {isDeleting ? 'Deleting…' : 'Delete account'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
