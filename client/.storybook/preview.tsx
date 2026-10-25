import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// The reset + layer order main.tsx loads for the app; stories need the same document baseline.
import '../src/designSystem/tokens/base.css';
import type { Decorator, Preview } from '@storybook/react';
import { useEffect } from 'react';

// Stamps the toolbar's scheme the same way lib/colorScheme.ts does in the app, so DS stories render
// both palettes from the same tokens.
const withColorScheme: Decorator = (Story, context) => {
    const scheme = context.globals.colorScheme === 'dark' ? 'dark' : 'light';
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', scheme);
    }, [scheme]);
    return <Story />;
};

const preview: Preview = {
    globalTypes: {
        colorScheme: {
            description: 'Colour scheme (data-theme on <html>)',
            toolbar: {
                title: 'Theme',
                icon: 'paintbrush',
                items: [
                    { value: 'light', title: 'Light' },
                    { value: 'dark', title: 'Dark' },
                ],
                dynamicTitle: true,
            },
        },
    },
    initialGlobals: { colorScheme: 'light' },
    parameters: {
        controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
        layout: 'centered',
    },
    decorators: [withColorScheme],
};

export default preview;
