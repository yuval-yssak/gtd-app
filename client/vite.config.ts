import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        TanStackRouterVite(),
        VitePWA({
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.ts",
            includeAssets: ["vite.svg"],
            manifest: {
                name: "GTD App",
                short_name: "GTD App",
                description: "Getting Things Done App",
                theme_color: "#ffffff",
                icons: [
                    { src: "/vite.svg", sizes: "192x192", type: "image/svg+xml" },
                    { src: "/vite.svg", sizes: "512x512", type: "image/svg+xml" },
                ],
            },
            registerType: "prompt",
            injectRegister: "script",
        }),
    ],
    server: {
        // this is probably redundant with service worker
        proxy: {
            // This proxy will only be used in development
            "/api": {
                target: "http://localhost:4000", // Your backend server in development
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ""), // Optional: remove `/api` prefix in the path
            },
        },
    },
});
