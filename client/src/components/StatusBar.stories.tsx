import type { Decorator, Meta, StoryObj } from '@storybook/react';
import type { IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { openAppDB } from '../db/indexedDB';
import type { MyDB } from '../types/MyDB';
import { StatusBar } from './StatusBar';

// Opens the real app IDB once and injects it as the StatusBar `db` arg. The AccountReauthBanner child
// reads accounts via useAccounts(db) (IDB-backed, no provider needed) and renders null with no reauth
// event in flight, so these stories only exercise the online/offline indicator.
const WithDb: Decorator = (Story) => {
    const [db, setDb] = useState<IDBPDatabase<MyDB> | null>(null);
    useEffect(() => {
        let active = true;
        openAppDB().then((opened) => active && setDb(opened));
        return () => {
            active = false;
        };
    }, []);
    if (!db) {
        return <span>Loading…</span>;
    }
    return <Story args={{ db }} />;
};

const meta = {
    title: 'Components/StatusBar',
    component: StatusBar,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    decorators: [WithDb],
    // `db` is supplied by WithDb at render time (it's opened asynchronously). This placeholder only
    // satisfies the CSF arg type; the decorator's `args={{ db }}` overrides it.
    args: { db: null as unknown as IDBPDatabase<MyDB> },
} satisfies Meta<typeof StatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Online state — shows when navigator.onLine is true.
 * In most environments (browser, Storybook) this is the default.
 */
export const Online: Story = {};

/**
 * Offline state — patches navigator.onLine to false via a mounted component so the value
 * is in place when React's useSyncExternalStore reads it on first render.
 * Synchronous patching in a decorator would be restored before React renders, defeating
 * the mock — the component approach ensures it remains active throughout the lifecycle.
 */
export const Offline: Story = {
    decorators: [
        (Story) => {
            function OfflineWrapper({ children }: { children: React.ReactNode }) {
                useEffect(() => {
                    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
                    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
                    // Trigger the 'offline' event so useSyncExternalStore re-reads the patched value.
                    window.dispatchEvent(new Event('offline'));
                    return () => {
                        if (descriptor) {
                            Object.defineProperty(navigator, 'onLine', descriptor);
                            window.dispatchEvent(new Event('online'));
                        }
                    };
                }, []);
                return <>{children}</>;
            }
            return (
                <OfflineWrapper>
                    <Story />
                </OfflineWrapper>
            );
        },
    ],
};
