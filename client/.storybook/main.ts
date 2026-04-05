import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
    stories: ['../src/**/*.stories.tsx'],
    addons: ['@storybook/addon-essentials', '@storybook/addon-a11y'],
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
        return config;
    },
};

export default config;
