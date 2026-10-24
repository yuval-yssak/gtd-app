import { createLink, useLocation } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import {
    Bookmark,
    Calendar,
    CalendarClock,
    CheckCheck,
    ClipboardCheck,
    Hourglass,
    Inbox,
    type LucideIcon,
    Menu,
    Repeat,
    Search,
    Settings,
    Tag,
    Trash2,
    Users,
    Zap,
} from 'lucide-react';
import type { AnchorHTMLAttributes, Ref } from 'react';
import { Badge, Drawer, Text } from '../designSystem';
import { type RovingRegionApi, useRovingRegion } from '../hooks/useRovingRegion';
import { APP_NAME } from '../lib/appName';
import { useNewTabAwareNavigate } from '../lib/newTabNavigation';
import type { FileRouteTypes } from '../routeTree.gen';
import type { MyDB } from '../types/MyDB';
import { AccountSwitcher } from './AccountSwitcher';
import styles from './AppNav.module.css';
import { KeyboardShortcutsButton } from './KeyboardShortcutsButton';
import { StatusBar } from './StatusBar';

interface NavItemConfig {
    label: string;
    icon: LucideIcon;
    to: FileRouteTypes['to'];
    badgeCount?: number;
}

const primaryItems: NavItemConfig[] = [
    { label: 'Inbox', icon: Inbox, to: '/inbox' },
    { label: 'Next Actions', icon: Zap, to: '/next-actions' },
    { label: 'Calendar', icon: Calendar, to: '/calendar' },
    { label: 'Waiting For', icon: Hourglass, to: '/waiting-for' },
    { label: 'Tickler', icon: CalendarClock, to: '/tickler' },
    { label: 'Someday / Maybe', icon: Bookmark, to: '/someday' },
];

const secondaryItems: NavItemConfig[] = [
    { label: 'Routines', icon: Repeat, to: '/routines' },
    { label: 'People', icon: Users, to: '/people' },
    { label: 'Work Contexts', icon: Tag, to: '/work-contexts' },
];

const tertiaryItems: NavItemConfig[] = [
    { label: 'Search', icon: Search, to: '/search' },
    { label: 'Weekly Review', icon: ClipboardCheck, to: '/weekly-review' },
    { label: 'Done', icon: CheckCheck, to: '/done' },
    { label: 'Trash', icon: Trash2, to: '/trash' },
];

const settingsNavItem: NavItemConfig = { label: 'Settings', icon: Settings, to: '/settings' };

const NAV_GROUPS = [primaryItems, secondaryItems, tertiaryItems, [settingsNavItem]];

// Bottom nav shows only the 4 most-used daily-driver sections
const bottomNavItems = primaryItems.slice(0, 4);

const NAV_ICON_SIZE = 18;

// A real <a href> fused with TanStack's Link: middle-click / cmd-click / "Open in new tab" work, and
// each row is a single tab stop. TanStack marks the active link with aria-current="page".
const NavAnchor = ({ ref, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement> }) => <a ref={ref} {...props} />;
const NavLink = createLink(NavAnchor);

interface NavListItemProps {
    item: NavItemConfig;
    onItemClick: () => void;
    /** The menu region's item props: the links leave the tab order and ↑/↓ walk them. */
    itemProps: RovingRegionApi['itemProps'];
}

function NavListItem({ item, onItemClick, itemProps }: NavListItemProps) {
    const Icon = item.icon;
    return (
        <li>
            <NavLink to={item.to} onClick={onItemClick} className={styles.navLink} {...itemProps}>
                <span className={styles.navIcon} aria-hidden="true">
                    {item.badgeCount === undefined ? (
                        <Icon size={NAV_ICON_SIZE} />
                    ) : (
                        <Badge count={item.badgeCount}>
                            <Icon size={NAV_ICON_SIZE} />
                        </Badge>
                    )}
                </span>
                {item.label}
            </NavLink>
        </li>
    );
}

interface DrawerContentProps {
    onItemClick: () => void;
    db: IDBPDatabase<MyDB>;
}

function DrawerContent({ onItemClick, db }: DrawerContentProps) {
    // The whole menu is ONE tab stop entered on the current page's link; ↑/↓/Home/End walk it.
    // `aria-current="page"` is TanStack Link's own mark for the active link.
    const menu = useRovingRegion({ orientation: 'vertical', label: 'Main menu', preferredItemSelector: '[aria-current="page"]', isPreferredSticky: true });

    return (
        <div className={styles.drawerContent}>
            <div className={styles.logoRow}>
                <Text variant="titleSm" as="span" tone="accent" weight="bold" data-testid="appBrand">
                    {APP_NAME}
                </Text>
                {/* Touch has no shortcuts, so the legend button is desktop-only. */}
                <span className={styles.desktopOnly}>
                    <KeyboardShortcutsButton />
                </span>
            </div>
            <nav aria-label="Main" className={styles.navScrollArea}>
                <ul className={styles.navList} data-testid="mainMenu" {...menu.regionProps}>
                    {NAV_GROUPS.map((group, groupIndex) => (
                        <NavGroup
                            key={group[0]?.to ?? groupIndex}
                            items={group}
                            isFirst={groupIndex === 0}
                            onItemClick={onItemClick}
                            itemProps={menu.itemProps}
                        />
                    ))}
                </ul>
            </nav>
            {/* Account + status — pinned to sidebar bottom */}
            <div className={styles.drawerFooter}>
                <div className={styles.accountRow}>
                    <AccountSwitcher db={db} />
                </div>
                <StatusBar db={db} />
            </div>
        </div>
    );
}

function NavGroup({ items, isFirst, onItemClick, itemProps }: { items: NavItemConfig[]; isFirst: boolean } & Omit<NavListItemProps, 'item'>) {
    return (
        <>
            {!isFirst && <li aria-hidden="true" className={styles.divider} />}
            {items.map((item) => (
                <NavListItem key={item.to} item={item} onItemClick={onItemClick} itemProps={itemProps} />
            ))}
        </>
    );
}

interface AppNavProps {
    isMobileDrawerOpen: boolean;
    setIsMobileDrawerOpen: (open: boolean) => void;
    db: IDBPDatabase<MyDB>;
}

export function AppNav({ isMobileDrawerOpen, setIsMobileDrawerOpen, db }: AppNavProps) {
    return (
        <>
            {/* Permanent sidebar — desktop only */}
            <aside className={styles.permanentSidebar}>
                <DrawerContent onItemClick={() => {}} db={db} />
            </aside>

            {/* Mobile drawer — unmounted while closed, so its menu region is out of the DOM (keyboard regions rely on that). */}
            <Drawer open={isMobileDrawerOpen} onClose={() => setIsMobileDrawerOpen(false)} aria-label="Navigation">
                <DrawerContent onItemClick={() => setIsMobileDrawerOpen(false)} db={db} />
            </Drawer>

            <BottomNav onMoreClick={() => setIsMobileDrawerOpen(true)} />
        </>
    );
}

/** The phone tab bar: the four daily lists plus "More", which opens the drawer. */
function BottomNav({ onMoreClick }: { onMoreClick: () => void }) {
    const { pathname } = useLocation();
    const navigateOrNewTab = useNewTabAwareNavigate();
    // "More" is highlighted when the current page is outside the 4 bottom-nav items
    const isBottomNavRoute = bottomNavItems.some((item) => item.to === pathname);

    return (
        <nav aria-label="Primary" className={styles.bottomNav}>
            {bottomNavItems.map((item) => {
                const Icon = item.icon;
                return (
                    <button
                        key={item.to}
                        type="button"
                        className={styles.bottomNavAction}
                        data-selected={pathname === item.to || undefined}
                        aria-current={pathname === item.to ? 'page' : undefined}
                        // navigateOrNewTab keeps cmd/ctrl-click opening a new tab, like the sidebar links.
                        onClick={(event) => navigateOrNewTab(event, { to: item.to as never })}
                    >
                        <Icon size={20} aria-hidden="true" />
                        <span className={styles.bottomNavLabel}>{item.label}</span>
                    </button>
                );
            })}
            <button type="button" className={styles.bottomNavAction} data-selected={!isBottomNavRoute || undefined} onClick={onMoreClick}>
                <Menu size={20} aria-hidden="true" />
                <span className={styles.bottomNavLabel}>More</span>
            </button>
        </nav>
    );
}
