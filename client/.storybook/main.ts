import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

type ConditionalImport = { test?: string; default: string };

/**
 * package.json's `imports` map — the `#api/*` test seams — resolved to their real (`default`)
 * modules. Read from the manifest so a new seam is covered without touching this file.
 */
function realImportAliases() {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { imports?: Record<string, string | ConditionalImport> };
    return Object.entries(manifest.imports ?? {}).map(([find, target]) => ({
        find,
        // An unconditional entry is a plain path; a conditional one maps `default` to the real module.
        replacement: resolve(__dirname, '..', typeof target === 'string' ? target : target.default),
    }));
}

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
        const realApiAliases = realImportAliases();
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
