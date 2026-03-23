import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

export default defineConfig({
    plugins: [
        // TanStackRouterVite must come before react() so it generates routeTree.gen.ts first
        TanStackRouterVite({ routesDirectory: './src/routes' }),
        react(),
    ],
    server: {
        proxy: {
            // Proxy /auth/* to the API server in dev so OAuth cookies are same-origin.
            // Exclude /auth/callback exactly — that's a client-side TanStack Router route.
            '^/auth/(?!callback($|\\?|#))': { target: 'http://localhost:4000', changeOrigin: true },
        },
    },
})
