import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
    stories: ['../src/**/*.stories.tsx'],
    // @storybook/addon-essentials is bundled into storybook v10 core — no longer a separate addon
    addons: ['@storybook/addon-a11y'],
    framework: {
        name: '@storybook/react-vite',
        options: {},
    },
    viteFinal: (config) => {
        // Remove the TanStack Router code-gen plugin and VitePWA: both require the full
        // app build environment (file-based routing, service worker) that Storybook doesn't need.
        config.plugins = (config.plugins ?? []).filter((plugin) => {
            if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) return true;
            const name = (plugin as { name?: string }).name ?? '';
            return !name.includes('tanstack-router') && !name.includes('vite-plugin-pwa');
        });

        // Storybook 10 enables Vitest Browser Mode internally, which causes Vite to apply
        // the "test" package.json condition. That resolves #api/syncClient to the mock
        // companion (syncClient.mock.ts), which imports `vi` from vitest. Vitest's chai
        // initialisation then crashes because the vitest runner context doesn't exist in
        // the browser. Force the alias to the real implementation to prevent this.
        const realSyncClientPath = resolve(__dirname, '../src/api/syncClient.ts');
        config.resolve ??= {};
        if (Array.isArray(config.resolve.alias)) {
            config.resolve.alias.push({ find: '#api/syncClient', replacement: realSyncClientPath });
        } else {
            config.resolve.alias = { ...config.resolve.alias, '#api/syncClient': realSyncClientPath };
        }

        return config;
    },
};

export default config;
