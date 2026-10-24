import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './Tabs.module.css';

export type TabOption<V extends string | number> = {
    value: V;
    label: ReactNode;
    'data-testid'?: string | undefined;
};

type TabsProps<V extends string | number> = {
    value: V;
    onValueChange: (value: V) => void;
    tabs: readonly TabOption<V>[];
    'aria-label'?: string | undefined;
    className?: string | undefined;
};

/**
 * A tab strip (MUI Tabs). Renders only the `tablist`; callers render the panel for the selected
 * value themselves, as every call site did with MUI.
 */
export function Tabs<V extends string | number>({ value, onValueChange, tabs, className, ...rest }: TabsProps<V>) {
    return (
        // Each Tab below carries one of `tabs`' values, so the root can only report a V.
        <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as V)}>
            <BaseTabs.List {...rest} className={clsx(styles.list, className)}>
                {tabs.map((tab) => (
                    <BaseTabs.Tab key={tab.value} value={tab.value} data-testid={tab['data-testid']} className={styles.tab}>
                        {tab.label}
                    </BaseTabs.Tab>
                ))}
                <BaseTabs.Indicator className={styles.indicator} />
            </BaseTabs.List>
        </BaseTabs.Root>
    );
}
