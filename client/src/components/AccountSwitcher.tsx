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
import { useState } from 'react';
import { useAccounts } from '../hooks/useAccounts';
import { useOnline } from '../hooks/useOnline';
import type { MyDB, StoredAccount } from '../types/MyDB';
import styles from './AccountSwitcher.module.css';

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
    const { activeAccount, allAccounts, addAnotherAccount, switchToAccount, signOutCurrent, signOutAll } = useAccounts(db);
    const online = useOnline();

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
