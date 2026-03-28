import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import App from './App';
import { openAppDB } from './db/indexedDB';

async function main() {
    const db = await openAppDB();

    if (import.meta.env.DEV || window.location.hostname === 'localhost') {
        const { mountDevTools } = await import('./db/devTools');
        mountDevTools(db);
    }

    const rootEl = document.getElementById('root');
    if (!rootEl) throw new Error('Root element not found');

    createRoot(rootEl).render(
        <StrictMode>
            <App db={db} />
        </StrictMode>,
    );
}

// void: top-level await isn't available in this module context; discard the Promise explicitly
void main();
