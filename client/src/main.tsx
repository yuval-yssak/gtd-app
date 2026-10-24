import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// The layer order, tokens and document reset — loaded before any component stylesheet.
import './designSystem/tokens/base.css';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { RouteFallback } from './components/RouteFallback';
import { openAppDB } from './db/indexedDB';
import { ensureToastRegion } from './designSystem';
import { APP_NAME } from './lib/appName';
import { startColorSchemeSync } from './lib/colorScheme';

// Stamp <html data-theme> before anything renders (including the pre-React upgrade notice), so the
// first paint is already in the user's scheme; it then follows the OS and other tabs for the page's life.
startColorSchemeSync();
// The toasts' live region exists before any toast, so even the first one is announced.
ensureToastRegion();

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
        `A new version of ${APP_NAME} needs to update its local database. ` +
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
