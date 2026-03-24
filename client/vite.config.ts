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
                // Cache all build output so the app shell loads offline
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
            },
        }),
    ],
    server: {
        proxy: {
            // Proxy /auth/* to the API server in dev so OAuth cookies are same-origin.
            // Exclude /auth/callback exactly — that's a client-side TanStack Router route.
            '^/auth/(?!callback($|\\?|#))': { target: 'http://localhost:4000', changeOrigin: true },
            // Proxy /items so fetch('/items') works in dev without CORS or port issues
            '/items': { target: 'http://localhost:4000', changeOrigin: true },
        },
    },
});
