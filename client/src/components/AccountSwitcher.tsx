import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import LogoutIcon from '@mui/icons-material/Logout';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Backdrop from '@mui/material/Backdrop';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { type PendingAction, useAccounts } from '../hooks/useAccounts';
import { useOnline } from '../hooks/useOnline';
import type { MyDB, StoredAccount } from '../types/MyDB';
import styles from './AccountSwitcher.module.css';

const PENDING_LABELS: Record<PendingAction, string> = {
    switching: 'Switching account…',
    signingOut: 'Signing out…',
    signingOutAll: 'Signing out of all accounts…',
};

function AccountAvatar({ account, size }: { account: StoredAccount | undefined; size: number }) {
    // fontSize: MUI Avatar default is 1.25rem on 40px = ~0.375 ratio; scale it with size
    // Inline style used because width/height/fontSize are dynamic — computed from the size prop at runtime
    return (
        <Avatar src={account?.image ?? undefined} alt={account?.name ?? 'Account'} style={{ width: size, height: size, fontSize: size * 0.375 }}>
            {!account?.image && (account?.name?.[0]?.toUpperCase() ?? '?')}
        </Avatar>
    );
}

interface Props {
    db: IDBPDatabase<MyDB>;
}

export function AccountSwitcher({ db }: Props) {
    const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
    const { activeAccount, allAccounts, addAnotherAccount, switchToAccount, signOutCurrent, signOutAll, pendingAction, actionError, dismissActionError } =
        useAccounts(db);
    const online = useOnline();
    const isPending = pendingAction !== null;

    function openMenu(e: React.MouseEvent<HTMLElement>) {
        setMenuAnchor(e.currentTarget);
    }
    function closeMenu() {
        setMenuAnchor(null);
    }

    return (
        <>
            <IconButton onClick={openMenu} size="small" className={styles.menuButton} data-testid="accountSwitcherTrigger">
                <AccountAvatar account={activeAccount} size={32} />
            </IconButton>

            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu} onClick={closeMenu}>
                {allAccounts.map((account) => (
                    <MenuItem
                        key={account.id}
                        data-testid={`accountSwitcherItem-${account.id}`}
                        disabled={isPending}
                        onClick={() => {
                            if (account.id !== activeAccount?.id) {
                                void switchToAccount(account.id);
                            }
                        }}
                    >
                        <ListItemIcon>
                            <AccountAvatar account={account} size={24} />
                        </ListItemIcon>
                        <ListItemText
                            primary={account.name}
                            secondary={account.email}
                            slotProps={{ primary: { variant: 'body2' }, secondary: { variant: 'caption' } }}
                        />
                        {/* Checkmark on the currently active account */}
                        {account.id === activeAccount?.id && <CheckIcon fontSize="small" className={styles.checkIcon} />}
                    </MenuItem>
                ))}

                <Divider />

                <MenuItem disabled={!online || isPending} onClick={() => addAnotherAccount('google')}>
                    <ListItemIcon>
                        <AddIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Add Google account</Typography>} />
                </MenuItem>

                <MenuItem disabled={!online || isPending} onClick={() => addAnotherAccount('github')}>
                    <ListItemIcon>
                        <AddIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Add GitHub account</Typography>} />
                </MenuItem>

                <Divider />

                <MenuItem disabled={!online || isPending} onClick={() => void signOutCurrent()}>
                    <ListItemIcon>
                        <LogoutIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Sign out</Typography>} />
                </MenuItem>

                <MenuItem disabled={!online || isPending} onClick={() => void signOutAll()}>
                    <ListItemIcon>
                        <LogoutIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Sign out all accounts</Typography>} />
                </MenuItem>
            </Menu>

            {/*
                Blocking overlay while account-change requests are in flight. The async chain
                (signOutDevice + Better Auth signOut + setActive) takes a few seconds and ends in
                a hard navigation, so without this the UI looks frozen. zIndex is theme.zIndex.drawer + 1
                to land above the MUI sidebar nav. aria-busy/aria-live announce the in-flight state
                to screen readers, which otherwise just hear silence during the gap.
            */}
            <Backdrop
                open={isPending}
                sx={{
                    color: (theme) => theme.palette.common.white,
                    zIndex: (theme) => theme.zIndex.drawer + 1,
                    flexDirection: 'column',
                    gap: 2,
                }}
                data-testid="accountActionBackdrop"
                aria-busy={isPending}
                aria-live="polite"
            >
                <CircularProgress color="inherit" />
                {pendingAction && <Typography variant="body1">{PENDING_LABELS[pendingAction]}</Typography>}
            </Backdrop>

            {/*
                Surfaces failures from withPending in useAccounts. Without this, a failed sign-out
                drops the backdrop and leaves the user staring at a still-signed-in app with no
                clue what happened — exactly the "what just happened?" UX bug we're fixing, only
                shifted to the failure path.
            */}
            <Snackbar
                open={actionError !== null}
                autoHideDuration={6000}
                onClose={dismissActionError}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            >
                <Alert onClose={dismissActionError} severity="error" variant="filled" data-testid="accountActionError">
                    {actionError}
                </Alert>
            </Snackbar>
        </>
    );
}
