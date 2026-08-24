import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import './index.css';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { RouteFallback } from './components/RouteFallback';
import { openAppDB } from './db/indexedDB';

// Pre-React notice: openAppDB is still awaiting a schema upgrade blocked by an older connection
// (a stale tab or PWA window running the previous bundle), so React cannot mount yet. Once the
// stale tab closes, the upgrade completes and the render below replaces this content.
function showUpgradeBlockedNotice() {
    const rootEl = document.getElementById('root');
    if (!rootEl) {
        return;
    }
    const notice = document.createElement('p');
    notice.className = 'dbUpgradeBlockedNotice';
    notice.setAttribute('data-testid', 'dbUpgradeBlockedNotice');
    notice.textContent =
        'A new version of Getting Things Done needs to update its local database. ' +
        'Close any other tabs or windows running this app — or fully close and reopen the app — to continue.';
    rootEl.replaceChildren(notice);
}

async function main() {
    const db = await openAppDB({ onUpgradeBlocked: showUpgradeBlockedNotice });

    if (import.meta.env.DEV || window.location.hostname === 'localhost') {
        const { mountDevTools } = await import('./db/devTools');
        mountDevTools(db);
    }

    const rootEl = document.getElementById('root');
    if (!rootEl) {
        throw new Error('Root element not found');
    }

    // Outermost boundary catches any render/Suspense error before the router can render its own
    // error UI. Suspense fallback is the standard route fallback — once the data-resource layer
    // lands and starts suspending on boot, this is what the user sees during the first paint.
    createRoot(rootEl).render(
        <StrictMode>
            <AppErrorBoundary mode="page">
                <Suspense fallback={<RouteFallback testId="bootFallback" />}>
                    <App db={db} />
                </Suspense>
            </AppErrorBoundary>
        </StrictMode>,
    );
}

// void: top-level await isn't available in this module context; discard the Promise explicitly
void main();
