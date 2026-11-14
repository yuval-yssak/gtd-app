/**
 * A tab left open across a deploy still runs the old bundle, whose hashed chunk URLs the new deploy
 * no longer serves — a lazy import fired after the deploy fails ("Failed to fetch dynamically
 * imported module"). Warming every lazy chunk once the app is idle puts the modules in the tab's
 * module map early, so a later lazy() resolves from memory and never fetches the dead URL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleLazyChunkWarmup } from '../lib/lazyChunks';

function spyLoader() {
    return vi.fn(() => Promise.resolve({}));
}

function setOnline(isOnline: boolean) {
    vi.stubGlobal('navigator', { onLine: isOnline });
}

describe('scheduleLazyChunkWarmup — setTimeout fallback (no requestIdleCallback, e.g. Safari)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('requestIdleCallback', undefined);
        setOnline(true);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('loads nothing up front, then every chunk exactly once after the delay', () => {
        const loaders = [spyLoader(), spyLoader()];

        scheduleLazyChunkWarmup(loaders);
        expect(loaders.map((loader) => loader.mock.calls.length)).toEqual([0, 0]);

        vi.runAllTimers();
        expect(loaders.map((loader) => loader.mock.calls.length)).toEqual([1, 1]);
    });

    it('a failing chunk is swallowed and does not stop the others', async () => {
        const failing = vi.fn(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
        const healthy = spyLoader();

        scheduleLazyChunkWarmup([failing, healthy]);
        // Async so the rejection settles inside the test: an unhandled rejection would fail the run.
        await vi.runAllTimersAsync();

        expect(failing).toHaveBeenCalledTimes(1);
        expect(healthy).toHaveBeenCalledTimes(1);
    });

    it('skips the warm-up when the browser is offline by the time it runs', () => {
        const loader = spyLoader();

        scheduleLazyChunkWarmup([loader]);
        setOnline(false);
        vi.runAllTimers();

        expect(loader).not.toHaveBeenCalled();
    });
});

describe('scheduleLazyChunkWarmup — requestIdleCallback', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('waits for the idle callback (with a timeout so a busy page still warms)', () => {
        setOnline(true);
        const idleCallbacks: Array<() => void> = [];
        const requestIdleCallback = vi.fn((callback: () => void, _options?: { timeout: number }) => idleCallbacks.push(callback));
        vi.stubGlobal('requestIdleCallback', requestIdleCallback);
        const loader = spyLoader();

        scheduleLazyChunkWarmup([loader]);
        expect(loader).not.toHaveBeenCalled();
        expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: expect.any(Number) });

        for (const callback of idleCallbacks) callback();
        expect(loader).toHaveBeenCalledTimes(1);
    });
});

describe('lazyChunkLoaders registry', () => {
    const SRC_DIR = path.resolve(__dirname, '..');
    // Any dynamic import is a potential code-split boundary the warm-up would miss, whatever shape
    // the loader takes. Allowed: the registry itself, plus imports that never become their own chunk.
    const DYNAMIC_IMPORT = /(?<![\w.])import\(/g;
    const ALLOWED_DYNAMIC_IMPORT_FILES = new Set([
        path.join('lib', 'lazyChunks.ts'),
        // Dev-only harness, loaded on localhost.
        'main.tsx',
        // db/accountHelpers is also imported statically elsewhere, so Vite keeps it in the main chunk.
        path.join('hooks', 'useAccounts.ts'),
    ]);

    function productionSourceFiles() {
        return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter(
            (file) => /\.tsx?$/.test(file) && !/\.(test|stories|mock|gen)\.tsx?$/.test(file) && !file.startsWith('tests'),
        );
    }

    function dynamicImports(file: string) {
        const source = readFileSync(path.join(SRC_DIR, file), 'utf8');
        return [...source.matchAll(DYNAMIC_IMPORT)].map((match) => `${file}:${source.slice(0, match.index).split('\n').length}`);
    }

    it('dynamic imports live in lazyChunkLoaders, so the warm-up covers every lazy chunk', () => {
        const unregistered = productionSourceFiles()
            .filter((file) => !ALLOWED_DYNAMIC_IMPORT_FILES.has(file))
            .flatMap(dynamicImports);
        expect(unregistered).toEqual([]);
    });

    it('the scan recognises inline, async and hoisted loaders (guards the regex)', () => {
        const samples = ["lazy(() => import('./X'))", "lazy(async () => import('./X'))", "const load = () => import('./X');"];
        expect(samples.flatMap((sample) => [...sample.matchAll(DYNAMIC_IMPORT)])).toHaveLength(3);
    });
});
