import { useSyncExternalStore } from 'react';
import { Toast } from '../designSystem';
import { dismissAppNotice, getAppNotice, subscribeToAppNotice } from '../lib/appNotice';

/** The one host for `showAppNotice` — mounted by the authenticated layout, so it survives route changes. */
export function AppNoticeToast() {
    const notice = useSyncExternalStore(subscribeToAppNotice, getAppNotice);
    return (
        <Toast
            // Re-keyed per notice so a replacement restarts the auto-hide instead of inheriting the old timer.
            key={notice?.id ?? 'none'}
            open={notice !== null}
            message={notice?.message ?? ''}
            autoHideDuration={5000}
            onClose={() => notice && dismissAppNotice(notice.id)}
            data-testid="appNoticeToast"
        />
    );
}
