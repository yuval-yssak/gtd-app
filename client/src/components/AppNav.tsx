import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import BoltIcon from '@mui/icons-material/Bolt';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import EventNoteIcon from '@mui/icons-material/EventNote';
import GroupIcon from '@mui/icons-material/Group';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import InboxIcon from '@mui/icons-material/Inbox';
import LabelIcon from '@mui/icons-material/Label';
import LoopIcon from '@mui/icons-material/Loop';
import MenuIcon from '@mui/icons-material/Menu';
import SettingsIcon from '@mui/icons-material/Settings';
import Badge from '@mui/material/Badge';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import type { MyDB } from '../types/MyDB';
import { AccountSwitcher } from './AccountSwitcher';
import { StatusBar } from './StatusBar';

export const DRAWER_WIDTH = 240;

interface NavItemConfig {
    label: string;
    icon: React.ReactElement;
    to: string;
    badgeCount?: number;
}

const primaryItems: NavItemConfig[] = [
    { label: 'Inbox', icon: <InboxIcon fontSize="small" />, to: '/inbox' },
    { label: 'Next Actions', icon: <BoltIcon fontSize="small" />, to: '/next-actions' },
    { label: 'Calendar', icon: <CalendarTodayIcon fontSize="small" />, to: '/calendar' },
    { label: 'Waiting For', icon: <HourglassEmptyIcon fontSize="small" />, to: '/waiting-for' },
    { label: 'Tickler', icon: <EventNoteIcon fontSize="small" />, to: '/tickler' },
    { label: 'Someday / Maybe', icon: <BookmarkIcon fontSize="small" />, to: '/someday' },
];

const secondaryItems: NavItemConfig[] = [
    { label: 'Routines', icon: <LoopIcon fontSize="small" />, to: '/routines' },
    { label: 'People', icon: <GroupIcon fontSize="small" />, to: '/people' },
    { label: 'Work Contexts', icon: <LabelIcon fontSize="small" />, to: '/work-contexts' },
];

const tertiaryItems: NavItemConfig[] = [{ label: 'Weekly Review', icon: <AssignmentTurnedInIcon fontSize="small" />, to: '/weekly-review' }];

const settingsNavItem: NavItemConfig = { label: 'Settings', icon: <SettingsIcon fontSize="small" />, to: '/settings' };

// Bottom nav shows only the 4 most-used daily-driver sections
const bottomNavItems = primaryItems.slice(0, 4);

interface NavListItemProps {
    item: NavItemConfig;
    isActive: boolean;
    onItemClick: () => void;
}

function NavListItem({ item, isActive, onItemClick }: NavListItemProps) {
    const iconNode =
        item.badgeCount != null ? (
            <Badge badgeContent={item.badgeCount} color="primary" max={99}>
                {item.icon}
            </Badge>
        ) : (
            item.icon
        );

    return (
        <ListItem disablePadding>
            {/* Link wraps the button so the full row is a client-side navigation target */}
            <Link to={item.to as never} style={{ display: 'block', width: '100%', textDecoration: 'none', color: 'inherit' }}>
                <ListItemButton selected={isActive} onClick={onItemClick} dense>
                    <ListItemIcon sx={{ minWidth: 36 }}>{iconNode}</ListItemIcon>
                    <ListItemText primary={item.label} slotProps={{ primary: { variant: 'body2' } }} />
                </ListItemButton>
            </Link>
        </ListItem>
    );
}

interface DrawerContentProps {
    onItemClick: () => void;
    db: IDBPDatabase<MyDB>;
}

function DrawerContent({ onItemClick, db }: DrawerContentProps) {
    const { pathname } = useLocation();

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {/* Logo row — desktop only (mobile has the AppBar) */}
            <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', px: 2, py: 1.5 }}>
                <Typography variant="h6" fontWeight={700} color="primary">
                    GTD
                </Typography>
            </Box>

            {/* Spacer on mobile so nav list starts below the fixed AppBar */}
            <Box sx={{ display: { xs: 'block', md: 'none' } }}>
                <Toolbar />
            </Box>

            <Box sx={{ overflowY: 'auto', flexGrow: 1 }}>
                <List disablePadding>
                    {primaryItems.map((item) => (
                        <NavListItem key={item.to} item={item} isActive={pathname === item.to} onItemClick={onItemClick} />
                    ))}
                    <Divider sx={{ my: 0.5 }} />
                    {secondaryItems.map((item) => (
                        <NavListItem key={item.to} item={item} isActive={pathname === item.to} onItemClick={onItemClick} />
                    ))}
                    <Divider sx={{ my: 0.5 }} />
                    {tertiaryItems.map((item) => (
                        <NavListItem key={item.to} item={item} isActive={pathname === item.to} onItemClick={onItemClick} />
                    ))}
                    <Divider sx={{ my: 0.5 }} />
                    <NavListItem item={settingsNavItem} isActive={pathname === settingsNavItem.to} onItemClick={onItemClick} />
                </List>
            </Box>

            {/* Account + status — pinned to sidebar bottom */}
            <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.5 }}>
                    <AccountSwitcher db={db} />
                </Box>
                <StatusBar />
            </Box>
        </Box>
    );
}

interface AppNavProps {
    mobileDrawerOpen: boolean;
    setMobileDrawerOpen: (open: boolean) => void;
    db: IDBPDatabase<MyDB>;
}

export function AppNav({ mobileDrawerOpen, setMobileDrawerOpen, db }: AppNavProps) {
    const { pathname } = useLocation();
    const navigate = useNavigate();

    // "More" is highlighted when the current page is outside the 4 bottom-nav items
    const isBottomNavRoute = bottomNavItems.some((item) => item.to === pathname);
    const bottomNavValue = isBottomNavRoute ? pathname : 'more';

    return (
        <>
            {/* Permanent sidebar — desktop only */}
            <Drawer
                variant="permanent"
                sx={{
                    display: { xs: 'none', md: 'block' },
                    width: DRAWER_WIDTH,
                    flexShrink: 0,
                    '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
                }}
            >
                <DrawerContent onItemClick={() => {}} db={db} />
            </Drawer>

            {/* Temporary drawer — mobile only (slides in from left) */}
            <Drawer
                variant="temporary"
                open={mobileDrawerOpen}
                onClose={() => setMobileDrawerOpen(false)}
                ModalProps={{ keepMounted: true }}
                sx={{
                    display: { xs: 'block', md: 'none' },
                    '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
                }}
            >
                <DrawerContent onItemClick={() => setMobileDrawerOpen(false)} db={db} />
            </Drawer>

            {/* Bottom navigation — mobile only */}
            <Paper
                elevation={3}
                sx={{
                    display: { xs: 'block', md: 'none' },
                    position: 'fixed',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    zIndex: (theme) => theme.zIndex.appBar,
                }}
            >
                <BottomNavigation value={bottomNavValue} showLabels>
                    {bottomNavItems.map((item) => (
                        <BottomNavigationAction
                            key={item.to}
                            label={item.label}
                            value={item.to}
                            icon={item.icon}
                            // useNavigate instead of component=Link to avoid MUI/TanStack type conflicts
                            onClick={() => void navigate({ to: item.to as never })}
                        />
                    ))}
                    <BottomNavigationAction label="More" value="more" icon={<MenuIcon />} onClick={() => setMobileDrawerOpen(true)} />
                </BottomNavigation>
            </Paper>
        </>
    );
}
