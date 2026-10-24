import { execSync } from 'node:child_process';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_NAME } from './src/lib/appName.ts';

// The API the dev/preview proxy forwards to. The e2e stack runs its own API on another port
// (e2e/helpers/env.ts) and points the preview's proxy at it through this variable. Read once at
// config load — restart the dev/preview server to pick up a change.
const apiProxyTarget = process.env.GTD_API_PROXY_TARGET ?? 'http://localhost:4000';

// Proxy /auth/* (and the other cookie-bearing API routes) to the API so OAuth cookies are same-origin.
// Exclude /auth/callback exactly — that's a client-side TanStack Router route.
const apiProxy = {
    '^/auth/(?!callback($|\\?|#))': { target: apiProxyTarget, changeOrigin: true },
    '/items': { target: apiProxyTarget, changeOrigin: true },
    '/sync': { target: apiProxyTarget, changeOrigin: true },
    '/push': { target: apiProxyTarget, changeOrigin: true },
    '/version': { target: apiProxyTarget, changeOrigin: true },
};

const commitHash = (() => {
    try {
        return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
})();

export default defineConfig({
    define: {
        __COMMIT_HASH__: JSON.stringify(commitHash),
    },
    plugins: [
        // TanStackRouterVite must come before react() so it generates routeTree.gen.ts first
        TanStackRouterVite({ routesDirectory: './src/routes' }),
        react(),
        VitePWA({
            // injectManifest lets us write a custom SW (src/sw.ts) while still having
            // Workbox inject the hashed precache manifest at build time
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'serviceWorker.ts',
            registerType: 'autoUpdate',
            manifest: {
                name: APP_NAME,
                short_name: APP_NAME,
                theme_color: '#1976d2',
                background_color: '#ffffff',
                display: 'standalone',
                start_url: '/',
                icons: [
                    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
                    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
                ],
            },
            // The `workbox` option block applies only to `strategies: 'generateSW'`.
            // For `injectManifest`, configure precache globs under `injectManifest`.
            // Without this, Workbox's default `['**/*.{js,css,html}']` excludes fonts —
            // CSS @font-face URLs then fail offline and the app can't render its shell.
            injectManifest: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
            },
        }),
    ],
    server: { proxy: apiProxy },
    // `npm run dev` uses `vite preview` (not `vite dev`), and the `server` block only applies to `vite dev`.
    preview: { proxy: apiProxy },
});
