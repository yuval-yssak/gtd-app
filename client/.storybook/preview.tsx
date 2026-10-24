import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// The reset + layer order main.tsx loads for the app; stories need the same document baseline.
import '../src/designSystem/tokens/base.css';
import { CssVarsProvider, extendTheme } from '@mui/material/styles';
import type { Decorator, Preview } from '@storybook/react';
import { useEffect } from 'react';

// Only for the stories that still render MUI components; removed with MUI at the end of the migration.
// No CssBaseline: its unlayered element rules would beat the design-system reset in tokens/base.css.
const muiTheme = extendTheme({
    colorSchemes: { light: true, dark: true },
    colorSchemeSelector: '[data-color-scheme="%s"]',
});

// Stamps the toolbar's scheme the same way lib/colorScheme.ts does in the app, so DS stories render
// both palettes from the same tokens.
const withColorScheme: Decorator = (Story, context) => {
    const scheme = context.globals.colorScheme === 'dark' ? 'dark' : 'light';
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', scheme);
        document.documentElement.setAttribute('data-color-scheme', scheme);
    }, [scheme]);
    return <Story />;
};

const withMuiTheme: Decorator = (Story) => (
    <CssVarsProvider theme={muiTheme} storageManager={null}>
        <Story />
    </CssVarsProvider>
);

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
    decorators: [withMuiTheme, withColorScheme],
};

export default preview;
