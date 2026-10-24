import { Menu as BaseMenu } from '@base-ui/react/menu';
import { clsx } from 'clsx';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { MODAL_POPUP_ATTR } from '../../lib/keyboardRegionDom';
import styles from './Menu.module.css';

/**
 * Dropdown menu. Part names mirror Base UI: `MenuRoot` › `MenuTrigger` (renders your button) ›
 * `MenuPopup` (portal + positioner + popup) › `MenuItem` / `MenuCheckboxItem` / `MenuSeparator` /
 * `MenuGroupLabel`.
 */
export function MenuRoot(props: Pick<ComponentProps<typeof BaseMenu.Root>, 'open' | 'onOpenChange' | 'children' | 'modal'>) {
    return <BaseMenu.Root {...props} />;
}

/** The element that opens the menu — pass your DS `IconButton` / `Button` as `render`. */
export function MenuTrigger({ render, ...rest }: { render: ReactElement } & Omit<ComponentProps<typeof BaseMenu.Trigger>, 'render' | 'className'>) {
    return <BaseMenu.Trigger render={render} {...rest} />;
}

type MenuPopupProps = Omit<ComponentProps<typeof BaseMenu.Popup>, 'className'> & {
    className?: string | undefined;
    align?: ComponentProps<typeof BaseMenu.Positioner>['align'] | undefined;
    side?: ComponentProps<typeof BaseMenu.Positioner>['side'] | undefined;
};

export function MenuPopup({ align = 'start', side = 'bottom', className, children, ...rest }: MenuPopupProps) {
    return (
        <BaseMenu.Portal>
            <BaseMenu.Positioner align={align} side={side} sideOffset={4} collisionPadding={8} className={styles.positioner}>
                <BaseMenu.Popup {...{ [MODAL_POPUP_ATTR]: '' }} {...rest} className={clsx(styles.popup, className)}>
                    {children}
                </BaseMenu.Popup>
            </BaseMenu.Positioner>
        </BaseMenu.Portal>
    );
}

type MenuItemProps = Omit<ComponentProps<typeof BaseMenu.Item>, 'className' | 'children'> & {
    className?: string | undefined;
    children: ReactNode;
    /** Leading icon/avatar slot. */
    leading?: ReactNode | undefined;
    /** Trailing slot (a check mark, a shortcut). */
    trailing?: ReactNode | undefined;
    /** Second line under the label. */
    description?: ReactNode | undefined;
    tone?: 'neutral' | 'danger' | undefined;
};

export function MenuItem({ leading, trailing, description, tone = 'neutral', className, children, ...rest }: MenuItemProps) {
    return (
        <BaseMenu.Item data-tone={tone} {...rest} className={clsx(styles.item, className)}>
            <ItemLayout leading={leading} trailing={trailing} description={description}>
                {children}
            </ItemLayout>
        </BaseMenu.Item>
    );
}

type MenuCheckboxItemProps = Omit<ComponentProps<typeof BaseMenu.CheckboxItem>, 'className' | 'children'> & {
    className?: string | undefined;
    children: ReactNode;
};

/** `role="menuitemcheckbox"`; the menu stays open while toggling. */
export function MenuCheckboxItem({ className, children, ...rest }: MenuCheckboxItemProps) {
    return (
        <BaseMenu.CheckboxItem closeOnClick={false} {...rest} className={clsx(styles.item, className)}>
            <span className={styles.checkSlot} aria-hidden="true">
                <BaseMenu.CheckboxItemIndicator className={styles.checkIndicator}>
                    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.checkGlyph}>
                        <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                </BaseMenu.CheckboxItemIndicator>
            </span>
            <span className={styles.itemLabel}>{children}</span>
        </BaseMenu.CheckboxItem>
    );
}

function ItemLayout({ leading, trailing, description, children }: Pick<MenuItemProps, 'leading' | 'trailing' | 'description' | 'children'>) {
    return (
        <>
            {leading !== undefined && <span className={styles.leading}>{leading}</span>}
            <span className={styles.itemText}>
                <span className={styles.itemLabel}>{children}</span>
                {description !== undefined && <span className={styles.itemDescription}>{description}</span>}
            </span>
            {trailing !== undefined && <span className={styles.trailing}>{trailing}</span>}
        </>
    );
}

export function MenuSeparator() {
    return <BaseMenu.Separator className={styles.separator} />;
}

/** The heading of a `MenuGroup` (must sit inside one); a non-interactive note that names the group, still read by AT. */
export function MenuGroupLabel({ className, ...rest }: Omit<ComponentProps<typeof BaseMenu.GroupLabel>, 'className'> & { className?: string | undefined }) {
    return <BaseMenu.GroupLabel {...rest} className={clsx(styles.groupLabel, className)} />;
}

export function MenuGroup(props: Omit<ComponentProps<typeof BaseMenu.Group>, 'className'>) {
    return <BaseMenu.Group {...props} />;
}
