import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        // dotenv/config must run before any test file is evaluated so that config.ts
        // (which reads process.env at module init time) sees the env vars
        setupFiles: ['dotenv/config'],
        // Exclude compiled JS output — only run TypeScript sources
        exclude: ['**/node_modules/**', '**/build/**'],
    },
});
