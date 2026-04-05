import type { Decorator, Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { mockDb } from '../test-utils/storybookMocks';
import { NotificationNudge } from './NotificationNudge';

/**
 * Installs a Notification stub with the specified permission for the duration of the story.
 * Using a component (not synchronous decorator code) ensures the stub is active when React
 * reads Notification.permission inside useState — the decorator function returns JSX before
 * React renders, so any synchronous restore would run before the component mounts.
 *
 * Each Storybook story canvas is isolated, so cleanup is handled via useEffect teardown.
 */
function NotificationPermissionMock({ permission, children }: { permission: NotificationPermission; children: React.ReactNode }) {
    useEffect(() => {
        const original = window.Notification;
        Object.defineProperty(window, 'Notification', {
            value: { permission } as unknown as typeof Notification,
            configurable: true,
            writable: true,
        });
        return () => {
            if (original !== undefined) {
                Object.defineProperty(window, 'Notification', { value: original, configurable: true, writable: true });
            }
        };
    }, [permission]);

    return <>{children}</>;
}

function withNotificationPermission(permission: NotificationPermission): Decorator {
    return (Story) => (
        <NotificationPermissionMock permission={permission}>
            <Story />
        </NotificationPermissionMock>
    );
}

const meta = {
    title: 'Components/NotificationNudge',
    component: NotificationNudge,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
    args: { db: mockDb },
} satisfies Meta<typeof NotificationNudge>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default permission state — the nudge banner is visible.
 * The component checks `Notification.permission === 'default'` to decide
 * whether to show the enable prompt.
 */
export const PermissionDefault: Story = {
    decorators: [withNotificationPermission('default')],
};

/**
 * Permission already granted — the component returns null (empty canvas).
 * This confirms the nudge is properly hidden when notifications are enabled.
 */
export const PermissionGranted: Story = {
    decorators: [withNotificationPermission('granted')],
};

/**
 * Permission denied — the component returns null (empty canvas).
 */
export const PermissionDenied: Story = {
    decorators: [withNotificationPermission('denied')],
};

/**
 * Notification API not supported — `typeof Notification === 'undefined'`.
 * The component should render nothing (empty canvas).
 */
export const NotSupported: Story = {
    decorators: [
        (Story) => {
            // Wrap in a component so the delete happens before React reads Notification in useState.
            function UnsupportedMock({ children }: { children: React.ReactNode }) {
                useEffect(() => {
                    const original = window.Notification;
                    // @ts-expect-error — intentionally removing Notification to test the unsupported path
                    delete window.Notification;
                    return () => {
                        if (original !== undefined) {
                            Object.defineProperty(window, 'Notification', { value: original, configurable: true, writable: true });
                        }
                    };
                }, []);
                return <>{children}</>;
            }
            return (
                <UnsupportedMock>
                    <Story />
                </UnsupportedMock>
            );
        },
    ],
};
