import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The modules behind package.json's `#api/*` import aliases (each has a `.mock.ts` test seam).
const API_SEAM_MODULES = ['syncClient', 'syncApi', 'accountApi'];

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
        // Flattened first: VitePWA() returns a nested plugin array, which the filter would otherwise keep whole.
        config.plugins = (config.plugins ?? []).flat(Number.POSITIVE_INFINITY).filter((plugin) => {
            if (!plugin || typeof plugin !== 'object') return true;
            const name = (plugin as { name?: string }).name ?? '';
            return !name.startsWith('tanstack') && !name.startsWith('vite-plugin-pwa');
        });

        // Storybook 10 enables Vitest Browser Mode internally, which causes Vite to apply
        // the "test" package.json condition. That resolves every `#api/*` import to its mock
        // companion (`*.mock.ts`), which imports `vi` from vitest. Vitest's chai
        // initialisation then crashes because the vitest runner context doesn't exist in
        // the browser. Force each alias to the real implementation to prevent this.
        const realApiAliases = API_SEAM_MODULES.map((name) => ({ find: `#api/${name}`, replacement: resolve(__dirname, `../src/api/${name}.ts`) }));
        config.resolve ??= {};
        if (Array.isArray(config.resolve.alias)) {
            config.resolve.alias.push(...realApiAliases);
        } else {
            config.resolve.alias = { ...config.resolve.alias, ...Object.fromEntries(realApiAliases.map(({ find, replacement }) => [find, replacement])) };
        }

        return config;
    },
};

export default config;
