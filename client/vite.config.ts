import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    plugins: [
        // TanStackRouterVite must come before react() so it generates routeTree.gen.ts first
        TanStackRouterVite({ routesDirectory: './src/routes' }),
        react(),
        VitePWA({
            // injectManifest lets us write a custom SW (src/sw.ts) while still having
            // Workbox inject the hashed precache manifest at build time
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            registerType: 'autoUpdate',
            manifest: {
                name: 'Getting Things Done',
                short_name: 'GTD',
                theme_color: '#1976d2',
                background_color: '#ffffff',
                display: 'standalone',
                start_url: '/',
                icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
            },
        }),
    ],
    server: {
        proxy: {
            // Proxy /auth/* to the API server in dev so OAuth cookies are same-origin.
            // Exclude /auth/callback exactly — that's a client-side TanStack Router route.
            '^/auth/(?!callback($|\\?|#))': { target: 'http://localhost:4000', changeOrigin: true },
            '/items': { target: 'http://localhost:4000', changeOrigin: true },
            '/sync': { target: 'http://localhost:4000', changeOrigin: true },
            '/push': { target: 'http://localhost:4000', changeOrigin: true },
        },
    },
    preview: {
        // `npm run dev` uses `vite preview` (not `vite dev`), so proxy rules must be
        // duplicated here — the `server` block above only applies to `vite dev`.
        proxy: {
            '^/auth/(?!callback($|\\?|#))': { target: 'http://localhost:4000', changeOrigin: true },
            '/items': { target: 'http://localhost:4000', changeOrigin: true },
            '/sync': { target: 'http://localhost:4000', changeOrigin: true },
            '/push': { target: 'http://localhost:4000', changeOrigin: true },
        },
    },
});
