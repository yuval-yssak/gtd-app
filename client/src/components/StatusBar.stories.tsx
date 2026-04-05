import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { StatusBar } from './StatusBar';

const meta = {
    title: 'Components/StatusBar',
    component: StatusBar,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
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
