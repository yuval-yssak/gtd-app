import { isBrowserOffline } from './onlineStatus';

/**
 * Every React.lazy() chunk in the app. lazy() sites take their loader from here so that
 * `scheduleLazyChunkWarmup` covers each one (a source-scan test enforces it).
 *
 * Why warm them at all: a tab left open across a deploy keeps running the old bundle, whose hashed
 * chunk URLs the new deploy no longer serves — a lazy import fired after that fails with "Failed to
 * fetch dynamically imported module". A module imported once stays in the tab's module map, so
 * warming early makes later lazy() calls resolve from memory and never touch the dead URL. This
 * beats reloading on the failure, which could discard an unsaved edit as the notes editor opens.
 *
 * Not covered: @codemirror/language-data's per-language fence chunks (~100). After a deploy a stale
 * tab just loses highlighting in a not-yet-loaded fence — CodeMirror logs the failed import and retries.
 */
export const lazyChunkLoaders = {
    completionCelebration: () => import('../components/weeklyReview/CompletionCelebration'),
    markdownNotesEditorView: () => import('../components/markdown/MarkdownNotesEditorView'),
};

type LazyChunkLoader = () => Promise<unknown>;

// requestIdleCallback's timeout: a page that never goes idle still warms within this window.
const IDLE_TIMEOUT_MS = 5_000;
// Safari has no requestIdleCallback; a short delay keeps the warm-up off the first paint.
const NO_IDLE_CALLBACK_DELAY_MS = 2_000;

export function scheduleLazyChunkWarmup(loaders: readonly LazyChunkLoader[]) {
    whenIdle(() => {
        // Offline without a service worker the fetch fails, and a browser may cache that failure in
        // the module map — poisoning the on-demand load later, once back online. Leave it to lazy().
        if (isBrowserOffline()) return;
        loaders.forEach(warmChunk);
    });
}

function whenIdle(task: () => void) {
    if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
        return;
    }
    setTimeout(task, NO_IDLE_CALLBACK_DELAY_MS);
}

function warmChunk(load: LazyChunkLoader) {
    // A failed warm-up is harmless: the lazy() site loads the chunk again and owns the fallback UI.
    load().catch(() => undefined);
}
