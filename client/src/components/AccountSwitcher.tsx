import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import LogoutIcon from '@mui/icons-material/Logout';
import Avatar from '@mui/material/Avatar';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState, useSyncExternalStore } from 'react';
import { useAccounts } from '../hooks/useAccounts';
import type { MyDB } from '../types/MyDB';

// useSyncExternalStore ensures React re-renders on online/offline events without stale closure issues
function useOnline() {
    return useSyncExternalStore(
        (cb) => { window.addEventListener('online', cb); window.addEventListener('offline', cb); return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); }; },
        () => navigator.onLine,
    );
}

interface Props {
    db: IDBPDatabase<MyDB>;
}

export function AccountSwitcher({ db }: Props) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const { activeAccount, allAccounts, addAnotherAccount, switchToAccount, signOutCurrent, signOutAll } = useAccounts(db);
    const online = useOnline();

    function openMenu(e: React.MouseEvent<HTMLElement>) {
        setAnchor(e.currentTarget);
    }
    function closeMenu() {
        setAnchor(null);
    }

    return (
        <>
            <IconButton onClick={openMenu} size="small" sx={{ ml: 1 }}>
                <Avatar src={activeAccount?.image ?? undefined} alt={activeAccount?.name ?? 'Account'} sx={{ width: 32, height: 32 }}>
                    {/* Fallback initial when no avatar image is set */}
                    {!activeAccount?.image && (activeAccount?.name?.[0]?.toUpperCase() ?? '?')}
                </Avatar>
            </IconButton>

            <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={closeMenu} onClick={closeMenu}>
                {allAccounts.map((account) => (
                    <MenuItem
                        key={account.id}
                        onClick={() => {
                            if (account.id !== activeAccount?.id) {
                                void switchToAccount(account.id);
                            }
                        }}
                    >
                        <ListItemIcon>
                            <Avatar src={account.image ?? undefined} sx={{ width: 24, height: 24, fontSize: 12 }}>
                                {!account.image && (account.name[0]?.toUpperCase() ?? '?')}
                            </Avatar>
                        </ListItemIcon>
                        <ListItemText
                            primary={account.name}
                            secondary={account.email}
                            slotProps={{ primary: { variant: 'body2' }, secondary: { variant: 'caption' } }}
                        />
                        {/* Checkmark on the currently active account */}
                        {account.id === activeAccount?.id && <CheckIcon fontSize="small" sx={{ ml: 1, color: 'primary.main' }} />}
                    </MenuItem>
                ))}

                <Divider />

                <MenuItem disabled={!online} onClick={() => addAnotherAccount('google')}>
                    <ListItemIcon>
                        <AddIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Add Google account</Typography>} />
                </MenuItem>

                <MenuItem disabled={!online} onClick={() => addAnotherAccount('github')}>
                    <ListItemIcon>
                        <AddIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Add GitHub account</Typography>} />
                </MenuItem>

                <Divider />

                <MenuItem disabled={!online} onClick={() => void signOutCurrent()}>
                    <ListItemIcon>
                        <LogoutIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Sign out</Typography>} />
                </MenuItem>

                <MenuItem disabled={!online} onClick={() => void signOutAll()}>
                    <ListItemIcon>
                        <LogoutIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={<Typography variant="body2">Sign out all accounts</Typography>} />
                </MenuItem>
            </Menu>
        </>
    );
}
